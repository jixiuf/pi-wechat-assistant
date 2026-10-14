# Security

English | [简体中文](SECURITY.zh.md)

This extension handles local login credentials, message-send credentials, conversation content and project files. Never include real tokens, account identifiers, private messages or unredacted logs in public issues or pull requests.

## Reporting a vulnerability

If the repository's Security tab offers **Report a vulnerability**, use that private channel. Include the affected version, impact and a minimal reproduction with fake credentials. If private reporting is unavailable, open a public issue asking for a private reporting channel without disclosing exploit details or sensitive data.

Ordinary bugs without sensitive details can use the bug report template. Write the complete English report first, followed by the complete corresponding Chinese report; do not alternate languages by paragraph or subsection.

## Verification limits

Automated tests cover sender validation, ownership, queueing and extension behavior with mocked services. Passing tests or Pi API type checks does not establish the security of the external WeChat service or prove successful delivery with a real account.
