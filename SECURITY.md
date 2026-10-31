# Security policy

## Reporting a vulnerability

Please don't report security problems in public issues, discussions or pull requests.

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**.
Include what an attacker could do, the steps to reproduce it, and the version (`git describe --tags`).

We aim to answer within 3 working days and to keep you informed until it is fixed. Once a fix is released, we publish
an advisory and credit you, unless you'd rather we didn't.

## Supported versions

Ulka VMS is before 1.0: security fixes go into the latest release only. Upgrade to it to receive them.

## What counts

Anything that lets someone read, change or delete another workspace's data, play a private video without a valid
signed link, get past a permission, or run code on the server. Problems in your own server's setup (an exposed
database port, a weak `SEAL_KEY`) are worth telling us about if our documentation led to them.
