---
id: 2026-11-11-model-calls-can-use-cursor-xai-bedrock-i
date: 2026-11-11
kind: decision
author: "Cursor Agent"
source: manual
title: "Model calls can use Cursor, xAI, Bedrock IAM and Bedrock Mantle"
affects:
  - platform-foundation
  - integration-surfaces
---
# Model calls can use Cursor, xAI, Bedrock IAM and Bedrock Mantle

## Decision

Cursor is recognised through CURSOR_AGENT, so a session with no API key uses the host agent. Direct connectivity is Anthropic, OpenAI, LiteLLM, xAI (the cursor alias uses the same xAI API), Bedrock IAM via the AWS credential chain, and Bedrock Mantle with a bearer token or that chain. Bedrock is not handed to the host agent when no API key is set. The settings editor offers the same choices.
