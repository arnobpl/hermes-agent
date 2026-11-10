"""GPT-6 Luna native compaction is limited to the live-verified Codex OAuth route."""

from types import SimpleNamespace

import pytest

from agent.native_compaction import (
    native_compaction_context_management,
    resolve_native_compaction_capabilities,
)

_CODEX = "https://chatgpt.com/backend-api/codex"


@pytest.mark.parametrize("model,provider,base_url,eligible", [
    ("gpt-6-luna", "openai-codex", _CODEX, True),
    ("gpt-6-luna-900k", "openai-codex", _CODEX, True),
    ("GPT-6-LUNA", "openai-codex", "https://chatgpt.com:443/backend-api/codex/", True),
    ("gpt-6-luna", "openai", "https://api.openai.com/v1", False),
    ("gpt-6-luna", "openai", _CODEX, False),
    ("gpt-6-luna", "openai-codex", "https://relay.example/v1", False),
    ("gpt-6-luna", "openai-codex", "https://chatgpt.com.example/backend-api/codex", False),
    ("gpt-6-luna", "openai-codex", "http://chatgpt.com/backend-api/codex", False),
    ("openai/gpt-6-luna", "openai-codex", _CODEX, False),
    ("gpt-6-astra-mini", "openai-codex", _CODEX, False),
])
def test_luna_compaction_is_limited_to_the_verified_route(model, provider, base_url, eligible):
    is_codex = provider == "openai-codex"
    resolved = resolve_native_compaction_capabilities(
        model=model, provider=provider, base_url=base_url, is_codex_backend=is_codex,
    )
    assert resolved["native_compaction"] is eligible

    agent = SimpleNamespace(
        model=model,
        provider=provider,
        base_url=base_url,
        codex_responses_native_compaction=True,
        compression_enabled=True,
        capabilities={"openai_native_compaction": True},
    )
    for runtime in (None, resolved):
        agent.runtime_capabilities = runtime
        payload = native_compaction_context_management(agent, is_codex_backend=is_codex)
        assert (payload is not None) is eligible
