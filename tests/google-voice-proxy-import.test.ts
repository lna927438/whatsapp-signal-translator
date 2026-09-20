import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGoogleVoiceProxyImport as parse, type GoogleVoiceProxyProtocol } from '../src/shared/googleVoiceProxyImport.ts'

test('the supplied address:port:username:password format uses the explicitly selected protocol', () => {
  for (const protocol of ['http', 'https', 'socks5'] as const) {
    assert.deepEqual(parse('203.0.113.27:19080:account-session-123:secret-456', protocol), {
      protocol, host: '203.0.113.27', port: 19080, username: 'account-session-123', password: 'secret-456',
      enabled: true, hasPassword: false, clearPassword: false
    })
  }
})

test('standard authenticated URLs override the fallback and decode only their credentials', () => {
  const parsed = parse('socks5://user%3Aname:p%40ss%3Aword%2F%3F%23%25@Proxy.Example.com:1080', 'https')
  assert.equal(parsed.protocol, 'socks5'); assert.equal(parsed.host, 'proxy.example.com')
  assert.equal(parsed.username, 'user:name'); assert.equal(parsed.password, 'p@ss:word/?#%')
  assert.equal(parse('HTTP://user:pass@host.example:80', 'socks5').port, 80)
  assert.deepEqual(parse('https://user:pass@proxy.example:443/', 'http'), parse('https://user:pass@proxy.example:443', 'http'))
  for (const [protocol, port] of [['http', 80], ['https', 443], ['socks5', 1080]] as const) {
    assert.equal(parse(protocol + '://user:pass@proxy.example', 'http').port, port)
  }
})

test('no-auth endpoints clear stale saved passwords and username-first imports preserve literal credentials', () => {
  assert.deepEqual(parse('proxy.example:65535', 'https'), {
    protocol: 'https', host: 'proxy.example', port: 65535, username: '', password: '', enabled: true, hasPassword: false, clearPassword: true
  })
  const first = parse('user%3Aname:p%40ss:tail@proxy.example:8080', 'http')
  assert.equal(first.username, 'user%3Aname'); assert.equal(first.password, 'p%40ss:tail')
  const second = parse('proxy.example:8080:user%3Aname:p%40ss:tail', 'http')
  assert.equal(second.username, first.username); assert.equal(second.password, first.password)
  assert.equal(parse('proxy.example:8080:user:', 'http').clearPassword, true)
})

test('literal colon and at-sign passwords are kept when unambiguous and never guessed when both formats fit', () => {
  assert.equal(parse('proxy.example:8080:user:part:part@literal', 'http').password, 'part:part@literal')
  assert.equal(parse('proxy.example:8080:user:part@@literal', 'http').password, 'part@@literal')
  assert.equal(parse('user:part:part@proxy.example:8080', 'http').password, 'part:part')
  for (const value of ['proxy.example:8080:user:part@second.example:443', 'user:part@part@proxy.example:8080', 'http://user:part@part@proxy.example:8080']) {
    assert.throws(() => parse(value, 'http'))
  }
  assert.throws(() => parse('proxy.example:8080:user:part@second.example:443', 'http'), /歧义/)
})

test('raw delimited credentials preserve reserved URL characters after separating the endpoint', () => {
  const password = 'p/a?ss#x\\tail%2F:part'
  assert.equal(parse('proxy.example:1080:user:' + password, 'socks5').password, password)
  assert.equal(parse('user:' + password + '@proxy.example:1080', 'socks5').password, password)
  assert.equal(parse('proxy.example:8080:account/?#\\name:password', 'http').username, 'account/?#\\name')
  for (const input of ['proxy.example/path:8080:user:pass', 'proxy.example:8080/path:user:pass', 'user:pass@proxy.example:8080/path', 'user:pass@proxy.example:8080?query', 'user:pass@proxy.example:8080#fragment']) assert.throws(() => parse(input, 'http'))
})

test('IPv6 endpoints require brackets in every format and retain independent port and credentials', () => {
  for (const input of ['[2001:db8::1]:1080:user:pass', 'user:pass@[2001:db8::1]:1080', 'socks5://user:pass@[2001:db8::1]:1080']) {
    const parsed = parse(input, 'socks5')
    assert.equal(parsed.host, '2001:db8::1'); assert.equal(parsed.port, 1080)
    assert.equal(parsed.username, 'user'); assert.equal(parsed.password, 'pass')
  }
  for (const input of ['2001:db8::1:1080', '2001:db8::1:1080:user:pass', 'user:pass@2001:db8::1:1080', '[not-ip]:1080', '[2001:db8::1%25eth0]:1080', '[::1]8080']) assert.throws(() => parse(input, 'http'))
})

test('ports are strict decimal integers and endpoints cannot hide paths or invalid hosts', () => {
  for (const port of ['', '0', '-1', '65536', '1.5', '+80', '8e3', ' 80', '80 ', 'Infinity', '000080']) {
    assert.throws(() => parse('proxy.example:' + port + ':user:pass', 'http'))
    assert.throws(() => parse('http://user:pass@proxy.example:' + port, 'http'))
  }
  assert.equal(parse('proxy.example:1', 'http').port, 1)
  assert.equal(parse('proxy.example:0080', 'http').port, 80)
  for (const input of [':8080:user:pass', 'user:pass@:8080', 'http://:8080', 'proxy..example:8080', '-proxy.example:8080', '999.0.0.1:8080', '127.1:8080', '0177.0.0.1:8080', '0x7f000001:8080:user:pass', '0x7f.0.0.1:8080:user:pass', 'proxy.example:8080/path', 'http://proxy.example:8080/path', 'http://proxy.example:8080//', 'http://proxy.example:8080?x=1', 'http://proxy.example:8080#x', 'proxy.example:8080;direct://']) assert.throws(() => parse(input, 'http'))
})

test('SOCKS credentials must be complete and fit the RFC byte limits', () => {
  for (const input of ['proxy.example:1080:user:', 'proxy.example:1080::pass', 'socks5://user@proxy.example', 'socks5://:pass@proxy.example']) assert.throws(() => parse(input, 'socks5'), /同时填写/)
  assert.equal(parse('proxy.example:1080', 'socks5').username, '')
  assert.equal(parse('proxy.example:1080:' + 'a'.repeat(255) + ':p', 'socks5').username.length, 255)
  assert.throws(() => parse('proxy.example:1080:' + 'a'.repeat(256) + ':p', 'socks5'), /255/)
  assert.throws(() => parse('proxy.example:1080:user:' + '密'.repeat(86), 'socks5'), /255/)
  assert.equal(parse('proxy.example:1080:user:' + '密'.repeat(85), 'socks5').password, '密'.repeat(85))
  for (const protocol of ['http', 'https'] as const) assert.throws(() => parse(protocol + '://user%3Aname:pass@proxy.example:8080', protocol), /账号不能包含冒号/)
  assert.equal(parse('socks5://user%3Aname:pass@proxy.example:1080', 'http').username, 'user:name')
})

test('invalid imports remain atomic and errors contain neither credentials nor raw parser exceptions', () => {
  const secret = 'DO-NOT-ECHO-PRIVATE-CREDENTIAL'
  const inputs = [
    '', 'proxy.example:8080:user:' + secret + '\n', 'proxy.example:8080:user:' + secret + '\u0000',
    'proxy.example:8080:user:' + secret + '\u0085', 'proxy.example:8080:user:' + secret + '\u2028',
    'proxy.example:8080: user:' + secret, 'proxy.example:8080:user:' + secret + ' ',
    'http://user:' + secret + '%00@proxy.example:80', 'http://user:' + secret + '%zz@proxy.example:80',
    'http://user:' + secret + '%E0%A4@proxy.example:80', 'ftp://user:' + secret + '@proxy.example:80',
    'proxy.example:8080:' + 'u'.repeat(257) + ':' + secret, 'proxy.example:8080:user:' + secret.repeat(100),
    'a'.repeat(16385), 'a'.repeat(254) + ':8080:user:' + secret
  ]
  const draft = { protocol: 'https', host: 'unchanged.example', username: 'old', password: 'old-secret' }
  const before = structuredClone(draft)
  for (const input of inputs) {
    assert.throws(() => { Object.assign(draft, parse(input, 'http')) }, error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message.includes(secret), false)
      assert.equal(error.message.includes('Invalid URL'), false)
      return true
    })
    assert.deepEqual(draft, before)
  }
  assert.throws(() => parse('proxy.example:8080', 'ftp' as GoogleVoiceProxyProtocol), /协议/)
  assert.throws(() => parse(null as unknown as string, 'http'))
})
