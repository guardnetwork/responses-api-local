# Model selection and local client integration

## Defaults and verified combinations

The default is `gpt-6.1-sol` with `low` reasoning effort. After connecting an account, click **Test Combination** to verify the default and make the `local-default` alias available. To change the default, verify another combination and click **Set as Default**. Verification results are scoped to the current connection.

The app shows two base URLs. The OpenAI base URL ends in `/v1` and the Anthropic base URL ends in `/anthropic`. Both use the same local API key. The Anthropic endpoint accepts either a Bearer token or the `x-api-key` header.

| Base URL | Relative request path | Model field | Reasoning effort field |
| --- | --- | --- | --- |
| OpenAI | `/responses` | `model` | `reasoning.effort` |
| OpenAI | `/chat/completions` | `model` | `reasoning_effort` |
| Anthropic | `/v1/messages` | `model` | `output_config.effort` |

Each endpoint resolves the model and reasoning effort separately. Omitted fields use the current app defaults. Explicit values apply to the current request only. The gateway resolves the combination when it queues the request. Later changes to the defaults do not affect queued requests or their idempotent retries.

Clients that require a model ID can use `local-default` to follow the app defaults. The gateway also lists verified combination aliases, such as `local-gpt-6.1-sol--high`. It returns an error for an explicit effort that conflicts with an alias, an incorrect request field, or an unsupported or unverified combination.

## Switching models in a conversation

To switch models with Chat Completions or Messages, resend compatible conversation history in `messages` and specify the new model. With Responses, resend the history in `input`. Include portable messages and client-side tool call records. Omit reasoning blocks, encrypted state, and configuration specific to the old model.

Use `previous_response_id` to continue with the same model. If the selected model differs from the previous response's model, the gateway returns HTTP 409 and asks the client to resend compatible history. Omitted reasoning effort still uses the app default. Clients no longer need the `X-Responses-Defaults: app` header from 1.2.x. Requests queued before an upgrade can still be replayed with the same idempotency key.

## Model lists and compatibility

The OpenAI `/models` and Anthropic `/v1/models` paths are relative to their respective base URLs. They expose models and combination aliases that are listed by the embedded proxy and verified for the current connection. When the default passes both checks, `local-default` appears first. All three request endpoints return the selected combination in the `x-responses-model` and `x-responses-reasoning-effort` response headers. In a Responses body, `skill_store` distinguishes the selected values, the values forwarded, and the values reported by the upstream service.

Output limits depend on what the upstream service enforces. The Codex backend strips `max_output_tokens`, `max_completion_tokens`, and `max_tokens`. The gateway reports these fields in `x-responses-unsupported-parameters`. The compatibility endpoints support text and image input, client-side function tools, and streaming. The same header reports sampling settings, Anthropic caching settings, and thinking hints that are not applied. The compatibility endpoints do not implement hosted tools or token counting. They use `store=false` and follow the gateway's short-term local retention policy.

## Maintaining the model catalog

Candidates come from GPT-6 and later numbered model families. The build synchronizes model entries across Codex tiers from a [pinned upstream catalog](https://github.com/router-for-me/models/blob/9675b79b173ce950c75a13ef05cb939a7d32ce5b/models.json). It verifies the commit and SHA-256 from the [catalog source lock file](Gateway/src/model-catalog-source.json) and checks model IDs and reasoning effort levels against the [app catalog](Gateway/src/model-catalog.json). The embedded proxy's registry test and outbound request validation also use this catalog. When updating the upstream snapshot, review it and update both local catalog files together. The six candidates in 1.4.0 all list `low`, `medium`, `high`, `xhigh`, and `max`.

Verification requires a completed upstream response with a response ID and matching model and reasoning effort. A missing proxy catalog entry returns `proxy_model_not_listed`. A listed combination with no verification result returns `model_effort_not_verified`. An explicit upstream rejection retains the corresponding error, such as `upstream_model_access_denied`. A missing or mismatched upstream report produces a verification error. The client model lists exclude all of these combinations.
