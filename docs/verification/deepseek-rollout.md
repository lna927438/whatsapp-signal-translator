# HelloDog DeepSeek Flash rollout

The API Worker selects `TRANSLATION_PROVIDER=deepseek` and `DEEPSEEK_MODEL=deepseek-flash`.
Set `DEEPSEEK_API_KEY` as a Secret on `realtime-translator-api`, then deploy.
Never put a provider credential in the website, desktop client, repository or logs.

Translation uses `https://api.deepseek.com/responses`, with `reasoning.effort=none`
and `store=false`. Readiness uses the authenticated, non-inference `/models` endpoint.
An available readiness result does not prove balance or inference success.
There is no automatic fallback to OpenAI and no automatic inference retry.

The provider-metadata migration keeps the existing RPC signature, role grants,
claim locks, account checks and atomic settlement. Older claims without provider
metadata remain attributed to OpenAI; new DeepSeek claims are attributed to DeepSeek.

Validation: run `npm run typecheck --prefix tests` and `npm test --prefix tests`.
GitHub regression also tests native PostgreSQL concurrency.
After deploying the Secret, check `/health/translation` on both API hostnames and
perform one authenticated synthetic translation, then replay its request ID to
verify one usage record and one wallet debit. Do not claim live inference success
until this final check is complete.

Rollback: set `TRANSLATION_PROVIDER=openai` only with a valid OpenAI credential
and project model. The metadata migration is backward compatible.

References:
- https://api-docs.deepseek.com/guides/responses_api/
- https://api-docs.deepseek.com/guides/thinking_mode/
- https://api-docs.deepseek.com/quick_start/error_codes/
