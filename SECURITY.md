# Security

These SDKs sign payments with a key you hold. Please report anything that could let someone else use that key, sign a payment the client should refuse, raise a limit, or send your API key somewhere it should not go.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue.

Please include the package and version, the steps to reproduce, and the impact you expect. We aim to acknowledge a report within 3 business days.

## Supported versions

The SDKs are pre-release. Once published, only the latest version of each package gets security fixes.

## Releases

Releases will be published from this repository by GitHub Actions, from signed tags, with npm trusted publishing and provenance and PyPI trusted publishing. Check an npm release with `npm audit signatures`, and check that its provenance commit is the commit of the signed tag.
