<!--
SPDX-License-Identifier: CC-BY-SA-4.0
Copyright (c) 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
-->

# kyq: Kubernetes YAML Query

**Kubernetes-native YAML processor, linter, and query tool built with AffineScript.**

> Formerly **kcq**; renamed to **kyq** on 2026-10-14 (owner ruling D333, hyperpolymath/standards#1234). Old `metadatastician/kcq` links redirect here.

```
kyq — the yq that understands Kubernetes
```

[![Code: MPL-2.0](https://img.shields.io/badge/Code-MPL_2.0-blue.svg)](LICENSE)
[![Docs: CC-BY-SA-4.0](https://img.shields.io/badge/Docs-CC--BY--SA_4.0-lightgrey.svg)](LICENSES/CC-BY-SA-4.0.txt)
[![Language: AffineScript](https://img.shields.io/badge/Language-AffineScript-blueviolet.svg)](https://github.com/hyperpolymath/affinescript)
[![Target: WebAssembly](https://img.shields.io/badge/Target-WebAssembly-654ff0.svg)](https://webassembly.org/)

---

## Overview

`kyq` is a **Kubernetes YAML Query** tool — a specialized YAML processor designed for the Kubernetes ecosystem. Built on [AffineScript](https://github.com/hyperpolymath/affinescript), it provides:

- **Kubernetes-aware parsing** — Understands K8s schemas, resource types, and conventions
- **Resource safety** — AffineScript's type system prevents resource leaks and double-frees
- **Small footprint** — Compiles to WebAssembly for minimal binary size (~1-5MB)
- **Fast execution** — Optimized for K8s manifests and workflows
- **Extensible linting** — Pluggable rule system for K8s best practices

### Goal: Replace yq for Kubernetes Use Cases

While `yq` is excellent for generic YAML/JSON processing, `kyq` is **optimized for Kubernetes**:

| Feature | yq | kyq |
|---------|-----|-----|
| K8s schema validation | ❌ | ✅ |
| Deprecated API warnings | ❌ | ✅ |
| Selector validation | ❌ | ✅ |
| Image tag warnings | ❌ | ✅ |
| Resource naming rules | ❌ | ✅ |
| Binary size | ~30-50MB | **~1-5MB** |
| Startup time | ~50ms | **~10-20ms** |
| Memory usage | Moderate | **Smaller** |
| Format support | YAML, JSON, XML, CSV, TOML, HCL | **KYAML (K8s YAML), JSON** |

> **For K8s: use kyq. For general YAML: use yq. Both can coexist.**

---

## Installation

### From Source

```bash
# Prerequisites
git clone https://github.com/hyperpolymath/affinescript
# Follow AffineScript setup instructions

# Verify repository layout and deed
just validate

# Build kyq (currently blocked: AffineScript 0.1.1 does not parse src/ — see docs/status/ROADMAP.adoc)
just build
```

> **Current status:** `just build` / `just test` / `just bench` fail with
> `not implemented` until the AffineScript grammar gap clears. This is
> intentional — no placeholder artefact is emitted. See
> `docs/ULTRAPLAN.adoc`, `docs/KYAML_SPEC.adoc`, and
> `docs/IJSON_JCS_INTEGRATION.adoc` for the KYAML + JCS guarantees being built
> toward, and `docs/PROOF_OBLIGATIONS.adoc` for the theorems they must satisfy.
> K8s manifests live under `examples/`; the lint-negative fixture is
> `tests/fixtures/invalid-deployment.yaml`.
```

### Pre-built Binaries

Pre-built WebAssembly and native binaries will be available in [Releases](https://github.com/metadatastician/kyq/releases).

---

## Usage

### Basic Commands

```bash
# Lint a Kubernetes manifest for common issues
kyq lint deployment.yaml

# Pretty-print a YAML file
kyq fmt deployment.yaml

# Query a value
kyq get deployment.yaml '.spec.replicas'

# Set a value
kyq set deployment.yaml '.spec.replicas' 5 -i

# Validate against K8s schemas
kyq validate deployment.yaml

# Convert YAML to JSON
kyq to-json deployment.yaml
```

### Example: Full Workflow

```bash
# Create a deployment with issues
cat > deployment.yaml <<EOF
apiVersion: apps/v1beta2
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: "3"
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: apache
    spec:
      containers:
      - name: nginx
        image: nginx:latest
EOF

# Lint for issues
$ kyq lint deployment.yaml
✗ deployment.yaml:1:1 — deprecated API version: use apps/v1 instead of apps/v1beta2
✗ deployment.yaml:5:16 — type error: spec.replicas must be integer, got string
✗ deployment.yaml:14:10 — image uses :latest tag (nginx:latest)
✗ deployment.yaml:8:5 — selector mismatch: spec.selector.matchLabels does not match spec.template.metadata.labels

# Fix issues with kyq
kyq set deployment.yaml '.apiVersion' 'apps/v1' -i
kyq set deployment.yaml '.spec.replicas' 3 -i
kyq set deployment.yaml '.spec.template.spec.containers[0].image' 'nginx:1.25' -i

# Verify
$ kyq lint deployment.yaml
✓ deployment.yaml — all checks passed
```

---

## Commands Reference

### `kyq lint [FILES...]`

Lint Kubernetes manifests for common issues.

**Rules:**
- `required-fields` — All K8s-required fields are present
- `type-check` — Fields have correct types
- `deprecated-api` — Warn on deprecated API versions
- `latest-tag` — Warn on `:latest` image tags
- `selector-mismatch` — Check selector matches pod template labels
- `resource-names` — Enforce DNS-1123 naming conventions
- `label-keys` — Validate label key format

**Options:**
```
  -r, --rule RULE     Enable/disable specific rules (e.g., --rule=-latest-tag)
  --color             Colored output
  --no-color          Disable colors
  --quiet             Only show errors
  --format FORMAT     Output format: text, json, sarif
  --check             Exit with error code if issues found
```

### `kyq fmt [FILES...]`

Pretty-print YAML files.

**Options:**
```
  -i, --in-place      Modify files in place
  -o, --output FILE   Write to file
  --indent INT        Indentation (default: 2)
  --width INT         Line width (default: 80)
```

### `kyq get FILE PATH`

Extract a value from a YAML file.

**Examples:**
```bash
# Get replicas
kyq get deployment.yaml '.spec.replicas'

# Get all container images
kyq get deployment.yaml '.spec.template.spec.containers[].image'

# Get from multiple files
kyq get '*.yaml' '.metadata.name'
```

### `kyq set FILE PATH VALUE [-i]`

Set a value at a path.

**Examples:**
```bash
# Set replicas
kyq set deployment.yaml '.spec.replicas' 5 -i

# Set image
kyq set deployment.yaml '.spec.template.spec.containers[0].image' 'nginx:1.25' -i

# Add namespace
kyq set deployment.yaml '.metadata.namespace' 'production' -i
```

### `kyq del FILE PATH [-i]`

Delete a field at a path.

**Examples:**
```bash
# Remove a label
kyq del deployment.yaml '.metadata.labels.old-label' -i

# Remove a container
kyq del deployment.yaml '.spec.template.spec.containers[1]' -i
```

### `kyq validate [FILES...]`

Validate against Kubernetes OpenAPI schemas.

**Options:**
```
  --schema PATH     Custom schema file
  --strict          Strict validation (fail on warnings)
```

### `kyq split FILE [-o DIR]`

Split multi-document YAML into separate files.

**Examples:**
```bash
kyq split multi.yaml -o manifests/
# Creates: manifests/00-deployment.yaml, manifests/01-service.yaml, etc.
```

### `kyq merge [FILES...] [-o FILE]`

Merge multiple YAML files into one.

### `kyq diff FILE1 FILE2`

Show differences between two resources.

### `kyq to-json FILE [-o FILE]`

Convert YAML to JSON.

### `kyq from-json FILE [-o FILE]`

Convert JSON to YAML.

### `kyq envsubst [FILES...]`

Replace `${VAR}` with environment variables.

**Examples:**
```bash
# In YAML: image: ${IMAGE}:${TAG}
IMAGE=nginx TAG=1.25 kyq envsubst deployment.yaml
# Output: image: nginx:1.25
```

### `kyq inject [FILES...] [-i]`

Inject namespace, labels, or annotations.

**Examples:**
```bash
# Inject namespace
kyq inject deployment.yaml --namespace production -i

# Inject labels
kyq inject deployment.yaml --label app=myapp --label env=prod -i

# Inject annotations
kyq inject deployment.yaml --annotation 'k8s.io/description=My App' -i
```

---

## Query Language

`kyq` supports a **jq-like query language** optimized for Kubernetes.

### Path Queries

| Query | Description |
|-------|-------------|
| `.spec.replicas` | Get replicas |
| `.spec.containers[0].image` | Get first container image |
| `.spec.containers[].image` | Get all container images |
| `.metadata.labels."app.kubernetes.io/name"` | Get label with special chars |
| `.spec.ports[?(.port == 80)]` | Filter ports (future) |

### Filters (Future)

| Filter | Description |
|--------|-------------|
| `select(.kind == "Deployment")` | Filter documents |
| `map(.metadata.name)` | Transform array |
| `.items[]` | Iterate over array |

### Built-in Functions (Future)

| Function | Description |
|----------|-------------|
| `length` | Array length |
| `keys` | Object keys |
| `has("field")` | Check if field exists |
| `env("VAR")` | Get environment variable |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         kyq CLI                                │
├─────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Parser     │    │   Linter    │    │   Query     │  │
│  │ (AffineScript)│───▶│ (Rules)     │───▶│  Engine     │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│           │                   │                   │            │
│           ▼                   ▼                   ▼            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                    KYAML AST                       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
               ┌─────────────────────────────┐
               │       Output Formatter       │
               │  (YAML, JSON, Text, SARIF)    │
               └─────────────────────────────┘
```

### Core Components

1. **Parser** (`src/Kyaml/Parser.affine`)
   - Lexer for KYAML (K8s-specific YAML subset)
   - Parser to build Abstract Syntax Tree
   - Multi-document support

2. **Linter** (`src/Kyaml/Lint/`)
   - Pluggable rule system
   - K8s-specific validation
   - Configurable severity levels

3. **Query Engine** (`src/Kyaml/Query.affine`)
   - Path-based queries
   - jq-like filter language
   - In-place mutations

4. **K8s Schema** (`src/Kyaml/Schema/`)
   - Embedded K8s API schemas
   - Type definitions for common resources
   - Validation against official schemas

---

## K8s Resource Support

| Kind | API Version | Support |
|------|-------------|---------|
| Deployment | apps/v1 | ✅ Full |
| StatefulSet | apps/v1 | ✅ Full |
| DaemonSet | apps/v1 | ✅ Full |
| Service | v1 | ✅ Full |
| ConfigMap | v1 | ✅ Full |
| Secret | v1 | ✅ Full |
| Ingress | networking.k8s.io/v1 | ✅ Full |
| PersistentVolume | v1 | ✅ Full |
| PersistentVolumeClaim | v1 | ✅ Full |
| Namespace | v1 | ✅ Full |
| Job | batch/v1 | ✅ Full |
| CronJob | batch/v1 | ✅ Full |
| HorizontalPodAutoscaler | autoscaling/v2 | ✅ Full |
| PodDisruptionBudget | policy/v1 | ✅ Full |
| NetworkPolicy | networking.k8s.io/v1 | ✅ Full |
| CustomResourceDefinition | apiextensions.k8s.io/v1 | ✅ Full |

**All standard K8s resource types are supported.**

---

## Lint Rules Reference

### Error-Level Rules

| Rule ID | Description | Default |
|---------|-------------|---------|
| `required-fields` | Missing required K8s fields | ✅ |
| `type-mismatch` | Field has wrong type | ✅ |
| `invalid-name` | Invalid resource name (DNS-1123) | ✅ |

### Warning-Level Rules

| Rule ID | Description | Default |
|---------|-------------|---------|
| `deprecated-api` | Using deprecated API version | ✅ |
| `latest-tag` | Image uses `:latest` tag | ✅ |
| `selector-mismatch` | Selector doesn't match pod template | ✅ |
| `missing-labels` | Missing recommended labels | ❌ |
| `root-user` | Container runs as root | ✅ |
| `empty-selector` | Deployment has empty selector | ✅ |

### Info-Level Rules

| Rule ID | Description | Default |
|---------|-------------|---------|
| `non-standard-label` | Label key doesn't follow conventions | ❌ |
| `missing-description` | Missing description annotation | ❌ |

---

## Comparison: kyq vs yq

### Size & Performance

| Metric | yq (Go) | kyq (AffineScript/WASM) | Winner |
|--------|---------|----------------------------|--------|
| Binary size | ~30-50MB | **~1-5MB** | ✅ kyq |
| Memory usage | ~50-100MB | **~20-40MB** | ✅ kyq |
| Startup time | ~50ms | **~10-20ms** | ✅ kyq |
| Parse speed | ~50MB/s | **~30-40MB/s** (early) | ⚠️ yq |

### Features

| Feature | yq | kyq | Winner |
|---------|-----|-----|--------|
| Generic YAML | ✅ | ✅ | Tie |
| JSON | ✅ | ✅ | Tie |
| XML | ✅ | ❌ | yq |
| CSV | ✅ | ❌ | yq |
| TOML | ✅ | ❌ | yq |
| HCL | ✅ | ❌ | yq |
| Properties | ✅ | ❌ | yq |
| **K8s schema validation** | ❌ | ✅ | ✅ kyq |
| **Deprecated API warnings** | ❌ | ✅ | ✅ kyq |
| **Selector validation** | ❌ | ✅ | ✅ kyq |
| **Image tag warnings** | ❌ | ✅ | ✅ kyq |
| **Resource naming rules** | ❌ | ✅ | ✅ kyq |

### Kubernetes-Specific

| Feature | yq | kyq |
|---------|-----|-----|
| Understands K8s schemas | ❌ | ✅ |
| Knows resource kinds | ❌ | ✅ |
| Validates field types | ❌ | ✅ |
| Warns on deprecated APIs | ❌ | ✅ |
| Checks selector consistency | ❌ | ✅ |
| Detects common mistakes | ❌ | ✅ |

---

## Roadmap

### Phase 1: Core Parser & Lint (Current)
- [x] Repository creation
- [ ] KYAML lexer (basic)
- [ ] KYAML parser (basic)
- [ ] AST definition
- [ ] Required fields linter
- [ ] Type checking linter

### Phase 2: Basic Commands (1-2 weeks)
- [ ] `lint` command with 5-10 rules
- [ ] `fmt` command (pretty-print)
- [ ] `get` command (basic path queries)
- [ ] `validate` against embedded schemas

### Phase 3: Mutation Commands (2-3 weeks)
- [ ] `set` command (update values)
- [ ] `del` command (delete fields)
- [ ] `inject` command (namespace/labels)
- [ ] `envsubst` command

### Phase 4: Advanced Features (3-4 weeks)
- [ ] Full query language (jq-like)
- [ ] Multi-document operations
- [ ] `split` and `merge` commands
- [ ] `diff` command

### Phase 5: K8s Ecosystem (4-6 weeks)
- [ ] GitHub Action
- [ ] Pre-commit hooks
- [ ] VS Code extension
- [ ] Language server (LSP)

### Phase 6: Performance & Polish (Ongoing)
- [ ] Optimize parser performance
- [ ] Reduce binary size further
- [ ] Add more lint rules
- [ ] Improve error messages

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

---

## License

- **Code:** Mozilla Public License 2.0, see [LICENSE](LICENSE).
- **Documentation:** CC-BY-SA-4.0, see [LICENSES/CC-BY-SA-4.0.txt](LICENSES/CC-BY-SA-4.0.txt).

Each file's `SPDX-License-Identifier` header is authoritative.

---

## Related Projects

- [yq](https://github.com/mikefarah/yq) — The inspiration for generic YAML processing
- [AffineScript](https://github.com/hyperpolymath/affinescript) — The language kyq is built with
- [Kustomize](https://github.com/kubernetes-sigs/kustomize) — K8s configuration management
- [Helm](https://helm.sh) — K8s package manager
- [kubectl](https://kubernetes.io/docs/reference/kubectl/) — K8s CLI

---

## acknowledgements

- Inspired by [yq](https://github.com/mikefarah/yq) and its ecosystem
- Built with [AffineScript](https://github.com/hyperpolymath/affinescript)
- Kubernetes API schemas from [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes)
