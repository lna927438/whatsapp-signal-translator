const tcp = require('node:net')

// Local synthetic RFC 1928/1929 peer. Destinations are observed but NEVER dialed;
// successful CONNECT always pipes to the explicitly supplied loopback backend.
exports.makeSocksFixture = async function makeSocksFixture(backendPort, username, password, options = {}) {
  const sockets = new Set(), stats = { connections: 0, authAttempts: 0, authenticated: 0, targets: [] }
  let rejected = Boolean(options.rejectAuth)
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}) }
  const server = tcp.createServer(socket => {
    track(socket); stats.connections++
    let buffer = Buffer.alloc(0), state = 'hello'
    socket.setTimeout(10000, () => socket.destroy())
    const send = bytes => {
      if (options.fragmented && bytes.length > 1) { socket.write(bytes.subarray(0, 1)); setImmediate(() => { if (!socket.destroyed) socket.write(bytes.subarray(1)) }) }
      else socket.write(bytes)
    }
    const receive = chunk => {
      buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 65536) { socket.destroy(); return }
      for (;;) {
        if (state === 'hello') {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
          if (buffer[0] !== 5) { socket.destroy(); return }
          const methods = buffer.subarray(2, 2 + buffer[1]), selected = options.downgrade ? 0 : username || password ? 2 : 0
          buffer = buffer.subarray(2 + buffer[1]); send(Buffer.from([5, methods.includes(selected) || options.downgrade ? selected : 255]))
          state = selected === 2 ? 'auth' : 'request'; continue
        }
        if (state === 'auth') {
          if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return
          const nameLength = buffer[1], secretLength = buffer[2 + nameLength], total = 3 + nameLength + secretLength
          if (buffer.length < total) return
          stats.authAttempts++
          const accepted = !rejected && buffer[0] === 1 && buffer.subarray(2, 2 + nameLength).toString() === username && buffer.subarray(3 + nameLength, total).toString() === password
          buffer = buffer.subarray(total)
          if (!accepted) { socket.end(Buffer.from([1, 1])); return }
          stats.authenticated++; send(Buffer.from([1, 0])); state = 'request'; continue
        }
        if (state === 'request') {
          if (buffer.length < 5) return
          if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0) { socket.destroy(); return }
          const type = buffer[3], count = type === 1 ? 4 : type === 4 ? 16 : type === 3 ? buffer[4] : -1, offset = type === 3 ? 5 : 4
          if (count < 1) { socket.destroy(); return }
          if (buffer.length < offset + count + 2) return
          const bytes = buffer.subarray(offset, offset + count), host = type === 3 ? bytes.toString() : type === 1 ? [...bytes].join('.') : bytes.toString('hex'), port = buffer.readUInt16BE(offset + count)
          stats.targets.push({ type, host, port }); buffer = buffer.subarray(offset + count + 2); state = 'tunnel'
          socket.pause(); socket.off('data', receive)
          const upstream = tcp.connect(backendPort, '127.0.0.1', () => {
            const result = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]); result.writeUInt16BE(backendPort, 8); socket.write(result)
            socket.setTimeout(0); if (buffer.length) upstream.write(buffer)
            socket.pipe(upstream); upstream.pipe(socket)
          })
          track(upstream); upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy())
          return
        }
        return
      }
    }
    socket.on('data', receive)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    stats, server, port: server.address().port, setRejectAuth(value) { rejected = value },
    dropConnections() { for (const socket of sockets) socket.destroy() },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) }
  }
}
