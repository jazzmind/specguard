## **Hackathon idea: Req2Test MCP Agent**

Build an MCP-powered agent that reads requirements \+ Git code, understands the application, and generates:

Unit tests, functional tests, regression tests, security tests, test data, coverage reports, and end-user documentation.

MCP is a good fit because it standardizes how AI agents connect to tools and data sources, and there are official/reference MCP server examples available. For open-source/local LLM execution, Ollama is a practical choice because it supports running open models locally.

## **MVP scope for hackathon**

Build a working demo for one repo, one requirements document, and one language stack.

**Inputs**

* Git repo URL or uploaded code folder  
* Requirements document: PDF, Word, Markdown, Jira export, or plain text  
* Optional: architecture notes, API specs, existing test cases

**Outputs**

* Requirement-to-test traceability matrix  
* Generated unit tests  
* Generated functional/API tests  
* Regression test suite proposal  
* Security test checklist or runnable tests  
* End-user documentation  
* Pull request with generated files

## **Architecture**

User  
 |  
 v  
Req2Test UI / CLI  
 |  
 v  
Agent Orchestrator  
 |  
 \+-- Requirements Skill  
 \+-- Code Understanding Skill  
 \+-- Test Strategy Skill  
 \+-- Unit Test Generator Skill  
 \+-- Functional Test Generator Skill  
 \+-- Security Test Skill  
 \+-- Regression Pack Skill  
 \+-- Documentation Skill  
 |  
 v  
MCP Servers  
 |  
 \+-- Git MCP: clone repo, read files, create branch, raise PR  
 \+-- File MCP: read requirements/docs  
 \+-- Test Runner MCP: run pytest/jest/junit/etc.  
 \+-- Static Analysis MCP: semgrep/bandit/eslint/sonarqube-like checks  
 \+-- Coverage MCP: generate coverage report  
 \+-- Local LLM MCP: Ollama / open model

## **Open-source stack \- Please change this basing on the need.**

Use this stack for the hackathon:

LLM runtime: Ollama  
Models: Qwen Coder, DeepSeek Coder, Code Llama, or Mistral-style coding model  
Agent framework: LangGraph, CrewAI, AutoGen, or custom Python orchestrator  
MCP: Model Context Protocol server/client  
Repo access: GitPython or GitHub API  
Test generation:  
 Python: pytest  
 Java: JUnit \+ Mockito  
 JavaScript/TypeScript: Jest/Vitest  
Security: Semgrep, Bandit, npm audit, OWASP ZAP optional  
Docs: MkDocs or Markdown  
UI: Streamlit or simple CLI

Continue and OpenHands are also relevant open-source coding-agent ecosystems to reference or integrate with. Continue provides AI coding assistant workflows, and OpenHands is positioned as an open-source, model-agnostic coding-agent platform.

## **Skills to build**

/skills  
 /requirements\_parser  
   SKILL.md  
   prompts.md  
   schema.json

 /code\_analyzer  
   SKILL.md  
   prompts.md

 /test\_case\_designer  
   SKILL.md  
   prompts.md

 /unit\_test\_generator  
   SKILL.md  
   templates/

 /functional\_test\_generator  
   SKILL.md  
   templates/

 /security\_test\_generator  
   SKILL.md  
   owasp\_mapping.md

 /regression\_suite\_builder  
   SKILL.md

 /documentation\_generator  
   SKILL.md  
   templates/

Each `SKILL.md` should define:

\# Skill: Unit Test Generator

\#\# Purpose  
Generate executable unit tests from requirements and source code.

\#\# Inputs  
\- Requirement IDs  
\- Source files  
\- Existing tests  
\- Language/framework  
\- Coverage target

\#\# Process  
1\. Identify testable functions/classes.  
2\. Map requirements to code paths.  
3\. Generate positive, negative, boundary, and error tests.  
4\. Run tests.  
5\. Fix failing tests when safe.  
6\. Produce traceability report.

\#\# Outputs  
\- Test files  
\- Coverage report  
\- Requirement-to-test matrix  
\- Known gaps


