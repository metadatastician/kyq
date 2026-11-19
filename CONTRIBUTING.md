// SPDX-License-Identifier: CC-BY-SA-4.0
// Copyright (c) 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>

# Contributing to kyq

We welcome contributions! This document outlines how to contribute to kyq.

## Development Setup

kyq is implemented in Rust. The retained `.affine` files under `src/`, `tests/`
and `benches/` are historical research and are not built.

### Prerequisites

1. **Rust** at the version in `rust-toolchain.toml`. `rustup` installs it when
   you run the first `cargo` command in the repository.
2. **just** at the version in `mise.toml`.
3. **Node.js 20 or later**, only for the independent conformance oracle in
   `conformance/`.
4. **Creusot**, **Agda** and **Rocq**, only when you change a proof. See
   `verification/README.adoc` and `verification/proofs/README.adoc`.

`just setup` installs the declared toolchain and runs diagnostics.

### Building and checking

```bash
git clone https://github.com/metadatastician/kyq
cd kyq

just build        # build the package
just test         # tests, benchmark smoke tests and documentation examples
just check        # the local acceptance sequence used before review
just conformance  # the independent JavaScript oracle
```

### Project structure

- `src/lib.rs`, `src/kyaml.rs`, `src/emit.rs`, `src/main.rs`: the library and
  the command-line tool.
- `tests/*.rs`: the native test suites. `tests/fixtures/` and
  `conformance/fixtures/` hold the shared corpus.
- `verification/bounds/`: the resource-budget kernel with its Pearlite
  contract (Creusot). `verification/PROOF-STATUS.adoc` is the proof ledger for
  the Rust code.
- `verification/proofs/`: the Agda theory spine and its Rocq recheck leg.
  `docs/status/PROOF-STATUS.adoc` is its ledger.
- `conformance/`: the JavaScript conformance oracle. It is a test oracle, not
  the implementation.
- `docs/architecture/REPOSITORY-MAP.adoc`: the generated map of every path.

The plan for the remaining work is `docs/ULTRAPLAN.adoc`, section 12.

## Writing Code

1. Follow `cargo fmt` and keep `cargo clippy --all-targets -- -D warnings` clean.
2. Handle errors explicitly. Every refusal has a diagnostic code, a position
   and a path.
3. Add a test for each change in behaviour. Do not weaken the reference corpus
   or its expectations.
4. Put a Creusot/Pearlite contract on the shipped function, not on a separate
   model. A proof row moves to `PROVEN` only after the verifier runs.
5. Do not claim that a tool, test or proof passed unless it ran.

## Testing

```bash
just test
```

Add inputs to `tests/fixtures/` or `conformance/fixtures/`, and the test case
to the matching file in `tests/`.

## Submitting Changes

1. **Fork the repository** (if you don't have push access)
2. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes**
4. **Add tests** for new functionality
5. **Update documentation** (README, docs)
6. **Run tests**
   ```bash
   just check
   ```
7. **Commit your changes** with a Conventional Commits subject (`feat:`, `fix:`, `docs:` …)
   ```bash
   git commit -m "feat: add your feature description"
   ```
8. **Push to the branch**
   ```bash
   git push origin feature/your-feature-name
   ```
9. **Open a Pull Request**

### Pull Request Guidelines

- Use a **clear, descriptive title**
- Provide a **detailed description** of changes
- Reference any **related issues**
- Include **screenshots or examples** if applicable
- Ensure all **tests pass**
- Update **documentation** as needed

### Commit Message Guidelines

- Use **imperative mood** ("Add feature" not "Added feature")
- Keep the **first line under 50 characters**
- Separate subject from body with a **blank line**
- Wrap the body at **72 characters**
- Explain **what** and **why**, not just **how**

Example:
```
Add selector validation lint rule

This rule checks that spec.selector.matchLabels matches
spec.template.metadata.labels in Deployment resources.

Fixes #123
```

## Code Review Process

1. **Initial review** by maintainers (1-2 days)
2. **Feedback** on design, implementation, tests
3. **Revisions** by contributor
4. **Final approval** and merge

We aim to review PRs within **2 business days**.

## Reporting Issues

When reporting issues, please include:

1. **Version** of kyq
2. **Operating system**
3. **Steps to reproduce**
4. **Expected behavior**
5. **Actual behavior**
6. **Sample input** (if applicable)

## Community

- **Discussions**: Use GitHub Discussions for questions and ideas
- **Issues**: Use GitHub Issues for bug reports and feature requests
- **Chat**: Join the [hyperpolymath Discord](https://discord.gg/...) for real-time discussion

## License

By contributing to kyq, you agree that your contributions will be licensed under the **MPL-2.0** (code) and **CC-BY-SA-4.0** (docs), as per `LICENSE` and `LICENSES/`. See [LICENSE](LICENSE) for details.
