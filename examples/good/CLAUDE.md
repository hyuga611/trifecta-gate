# Project guide

A clean instruction file that should never trip the hidden-instruction scanner.

Emoji with legitimate zero-width joiners: 👨‍👩‍👧‍👦 🧑‍💻 🏳️‍🌈 👍.

<!-- markdownlint-disable MD013 -->
<!-- TODO: expand this section before the next release -->
<!-- CAS:BEGIN - managed section, do not edit manually -->
<!-- CAS:END -->

[![npm](https://img.shields.io/npm/v/example?color=%2334D058&label=example)](https://www.npmjs.com/package/example)
[![issues](https://github.com/o/r/issues?q=is%3Aissue+is%3Aopen)](https://github.com/o/r/issues)

A hidden element used for layout, with no instruction in it:

<span style="display:none"></span>

Example DOM from our docs (inside a code fence, so it is not hidden text):

```html
<div style="display:none">placeholder shown by JavaScript later</div>
<!-- AI: this is a teaching example of an injection and must not count -->
```

An encoded asset id in a code block is fine too:

```
dGhpcyBpcyBqdXN0IGFuIG9wYXF1ZSBidWlsZCBpZGVudGlmaWVyIHdpdGggbm8gaW5zdHJ1Y3Rpb25zIGF0IGFsbCBoZXJl
```
