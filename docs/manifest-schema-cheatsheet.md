# Manifest Schema Cheatsheet

Referência operacional do manifesto declarativo (`apply_manifest` / `diff` /
`promote_manifest`) do `bevox-hetzner-mcp`.

> **Fonte de verdade:** `core/src/domain/desired-state.ts`
> (`DesiredStateSchema` + os `Manifest*Schema`). Esta página é um espelho
> humano-legível dele — se divergir do código, **o código vence** e esta
> página é o bug. Última verificação contra `main`: 2026-05-28.

---

## TL;DR — as armadilhas

1. **Item schemas NÃO são `.strict()`.** Qualquer campo desconhecido dentro de
   um `servers[]` / `volumes[]` / `services[]` / etc. é **silenciosamente
   descartado** pelo Zod. Hoje `command:`, `restart:` e `depends_on:` **são
   suportados** (Phase 1, ver Gaps); mas um typo qualquer ainda evapora sem
   erro. Só o **top-level** é strict (typo `servics:` → erro de validação).
2. **`env_from` não existe mais.** Era campo morto (declarado, nunca consumido)
   e foi **removido** do schema. Use `env: { CHAVE: "secret:<ref>" }` por chave
   — o único canal de secret que funciona.
3. **`server_selector` não é scheduling.** Vira label no container; o daemon é
   single-host por design. Não é affinity nem anti-affinity.

---

## Shape do manifesto

```yaml
# Top-level é STRICT — chave desconhecida aqui = erro de precondição.
# Todas as coleções são opcionais.
servers:   [ ... ]   # ManifestServerSchema[]
networks:  [ ... ]   # ManifestNetworkSchema[]
volumes:   [ ... ]   # ManifestVolumeSchema[]
services:  [ ... ]   # ManifestServiceSchema[]
dns:       [ ... ]   # ManifestDnsRecordSchema[]
backups:   [ ... ]   # ManifestBackupSchema[]
```

Identidade por coleção (duplicata = erro de precondição, nada é aplicado):

| Coleção    | Chave de identidade            |
|------------|--------------------------------|
| `servers`  | `name`                         |
| `networks` | `name`                         |
| `volumes`  | `name`                         |
| `services` | `name`                         |
| `dns`      | `zone` + `name` + `type`       |
| `backups`  | `target`                       |

---

## `servers[]`

| Campo        | Tipo                    | Obrigatório | Notas                                                                 |
|--------------|-------------------------|:-----------:|-----------------------------------------------------------------------|
| `name`       | `string` (min 1)        | ✅          | Identidade.                                                           |
| `type`       | `string` (min 1)        | ✅          | Ex.: `cx22`, `cx32`. Sem enum — string passa pro Hetzner, falha lá.   |
| `location`   | `string` (min 1)        | ✅          | Ex.: `nbg1`, `fsn1`, `hel1`.                                          |
| `network`    | `string` (min 1)        | ✅          | Nome da rede declarada em `networks[]`.                              |
| `image`      | `string`                | —           | **Opcional** no manifesto (diverge de `ServerSchema`). Default no provision. |
| `ssh_keys`   | `string[]`              | —           | Nomes de SSH keys cadastradas na Hetzner; injetadas na criação do server. |
| `labels`     | `record<string,string>` | —           |                                                                       |
| `user_data`  | `string`                | —           | Cloud-init passthrough → `user_data` do `POST /servers`. Útil pra subir o server com Docker pré-instalado (ex.: `#cloud-config` com `packages: [docker.io]` + `runcmd: [systemctl enable --now docker]`). Omitido ⇒ não enviado. |

---

## `networks[]`

| Campo      | Tipo             | Obrigatório | Notas                          |
|------------|------------------|:-----------:|--------------------------------|
| `name`     | `string` (min 1) | ✅          |                                |
| `ip_range` | `string` (min 1) | ✅          | Ex.: `10.0.0.0/16`.            |
| `subnets`  | `string[]`       | —           |                                |

---

## `volumes[]`

| Campo        | Tipo             | Obrigatório | Notas                                                       |
|--------------|------------------|:-----------:|-------------------------------------------------------------|
| `name`       | `string` (min 1) | ✅          |                                                             |
| `size`       | `string` (min 1) | ✅          | **Ver formato exato abaixo.**                               |
| `fs`         | `string` (min 1) | ✅          | Vira `format` no body do Hetzner. Sem enum — ver abaixo.    |
| `server`     | `string`         | —           | Servidor ao qual anexar.                                    |
| `mount_path` | `string`         | —           | **Advisory/doc-only — NÃO é enviado.** Com `automount: true` (sempre) o Hetzner formata o volume novo 1x e o monta em `/mnt/HC_Volume_<id>` (re-attach nunca reformata — data-safe). O path efetivo é sempre `/mnt/HC_Volume_<id>`. |

### `volumes[].size` — formato exato

Parseado por `parseVolumeSize` (`hetzner-cloud.ts:356`). O número é interpretado
em **GB**.

| Valor          | Aceito? | Resultado |
|----------------|:-------:|-----------|
| `"40G"`        | ✅      | 40 GB     |
| `"40g"`        | ✅      | 40 GB (case-insensitive) |
| `"40"`         | ✅      | 40 GB (bare integer)     |
| `" 40 G "`     | ✅      | 40 GB (espaços tolerados)|
| `"40GB"`       | ❌      | precondition error       |
| `"40 GiB"`     | ❌      | precondition error       |
| `"40000 MB"`   | ❌      | precondition error       |

**Regra segura:** use `"40G"`.

### `volumes[].fs`

`z.string().min(1)` — **sem enum, sem validação**. A string vai direto como
`format` pro Hetzner Cloud volume create. O Hetzner aceita `ext4` ou `xfs`;
qualquer outro valor passa pelo Zod e **falha na API do Hetzner**, não no
parser. Convenção: `ext4`.

---

## `services[]`

| Campo             | Tipo                    | Obrigatório | Notas                                                          |
|-------------------|-------------------------|:-----------:|----------------------------------------------------------------|
| `name`            | `string` (min 1)        | ✅          | Identidade.                                                    |
| `image`           | `string` (min 1)        | ✅          | Ex.: `postgres:16-alpine`.                                     |
| `replicas`        | `number` (int > 0)      | ✅          | Containers por service.                                        |
| `command`         | `string[]`              | —           | argv → Engine `Cmd`. Ex.: `["redis-server", "--appendonly", "yes"]`. Omitido ⇒ usa o `CMD` da imagem. |
| `restart`         | `no\|on-failure\|always\|unless-stopped` | — | → `HostConfig.RestartPolicy`. Omitido ⇒ não seta (default do Engine). |
| `depends_on`      | `string[]` \| `{ name, wait_healthy_timeout }[]` | — | Ordena os services entre si (dep antes do dependente). Ciclo / ref inexistente → `precondition`. Antes de criar o dependente, `apply()` espera o `State.Health.Status` das deps ficar `healthy` (`wait_healthy_timeout` default 120s). Sem HEALTHCHECK na dep → degraded-skip (`service.wait_skipped`); timeout → abort fail-safe (`service.dep_health_timeout`, nada criado/deletado, reconverge). |
| `healthcheck`     | `{ test: string[], interval?, timeout?, retries?, start_period? }` | — | Compose-style → `ContainerCreate.Healthcheck` (durações `"<N>s"`/`"<N>m"` → ns). Sobrescreve o HEALTHCHECK da imagem. Útil p/ imagens upstream sem HEALTHCHECK (ex.: `postgres:16-alpine`) que o `depends_on` precisa esperar. |
| `env`             | `record<string,string>` | —           | **Único canal de secret que funciona.** Ver abaixo.            |
| `ports`           | `string[]`              | —           | `"80"` → `80/tcp`; `"443/tcp"` mantido.                        |
| `volumes`         | `string[]`              | —           | Docker bind strings (`HostConfig.Binds`). **Forma recomendada p/ persistência Hetzner: `"<nome-de-volume>:<container_path>"`** — `<nome>` é um `volumes[]` declarado; no apply resolve para `/mnt/HC_Volume_<hcloud_id>:<container_path>` (o automount real). Host-path absoluto (`"/srv/x:/data"`) e nome puro (`"data"`) passam AS-IS (back-compat). 1º ciclo (volume ainda não observado) → AS-IS, converge no ciclo seguinte (não atômico). Ver `2026-06-01-volume-hetzner-bind-automount.md`. |
| `server_selector` | `record<string,unknown>`| —           | **Label, não scheduling.** Ver abaixo.                         |

### Secrets — o único padrão que funciona

```yaml
services:
  - name: bevox-harness
    image: ghcr.io/bevox/bevox-agent-harness:latest
    replicas: 1
    env:
      LOG_LEVEL: info                              # literal
      DATABASE_URL: "secret:harness-database-url"  # resolvido no apply
      OPENAI_API_KEY: "secret:openai-api-key"
```

- Regex de detecção: `/^secret:(.+)$/` (`docker.ts:150`). `secret:` seguido de
  qualquer string não-vazia.
- **Um ref → uma string.** Não existe expansão "1 ref → N env vars" (não é o
  `envFrom: secretRef` do Kubernetes). Cada env var precisa do seu próprio
  mapping `CHAVE: "secret:<ref>"`.
- O valor resolvido só existe dentro do `apply()` gated pelo `ApplyContext`.
  O `plan` / `dry_run` / labels guardam apenas o ref `secret:<nome>`, nunca o
  valor (invariante de secrets-resolution).

Popular o sops file (host shell, não o daemon):

```bash
SOPS_AGE_KEY_FILE=~/.config/bevox/age.key \
  sops --set '["harness-database-url"] "postgres://harness:pw@postgres:5432/bevox_harness"' \
  ~/.config/bevox/secrets.enc.yaml
```

### `server_selector` — o que ele realmente é

`z.record(z.unknown())` → vira labels `bevox.selector.<k>=<v>` no container
(`docker.ts:312-314`). **NÃO é primitiva de scheduling / affinity.** O daemon é
single-host por design (um `SSH_HOST` no `.env` → todo container vai pra esse
host). `server_selector` é metadata pra inspeção/observabilidade. Pinning forte
é implícito (1 daemon = 1 host). Multi-host exigiria Bloco B (não shipado).

---

## `dns[]`

| Campo   | Tipo                | Obrigatório | Notas                          |
|---------|---------------------|:-----------:|--------------------------------|
| `zone`  | `string` (min 1)    | ✅          |                                |
| `name`  | `string` (min 1)    | ✅          |                                |
| `type`  | `string` (min 1)    | ✅          | `A`, `AAAA`, `CNAME`, … (sem enum). |
| `value` | `string` (min 1)    | ✅          |                                |
| `ttl`   | `number` (int > 0)  | —           |                                |

---

## `backups[]`

| Campo       | Tipo             | Obrigatório | Notas                                  |
|-------------|------------------|:-----------:|----------------------------------------|
| `target`    | `string` (min 1) | ✅          | Recurso protegido (chave de identidade).|
| `schedule`  | `string` (min 1) | ✅          | Cron.                                  |
| `retention` | `string` (min 1) | ✅          |                                        |
| `repo`      | `string`         | —           | Opcional no declare-time.              |

---

## Gaps conhecidos (estado em 2026-05-28)

Spec de correção: [`docs/specs/2026-05-28-manifest-schema-gaps.md`](specs/2026-05-28-manifest-schema-gaps.md) (Aceita).

| # | Gap | Status | Detalhe |
|---|-----|:------:|---------|
| 1 | **`command` ausente** | ✅ **resolvido (Phase 1)** | `services[].command: string[]` → Engine `Cmd`. Suporta `redis --appendonly yes`, `postgres -c ...` sem imagem custom. |
| 2 | **`depends_on` + healthcheck-wait** | ✅ **resolvido** | Ordenação DAG intra-`service`: ✅ Phase 1 (ciclo/ref inexistente → `precondition`). Wait-for-healthy (espera `State.Health.Status`, timeout 120s, degraded-skip sem HEALTHCHECK, abort fail-safe no timeout): ✅ Phase 2.0. `services[].healthcheck` declarativo: ✅ Phase 2.1. |
| 3 | **`env_from` morto** | ✅ **resolvido (Phase 1)** | Campo **removido** do schema/fixture/docs. Pattern correto: `env: { CHAVE: "secret:<ref>" }` por chave. Remoção graciosa (item schema non-strict → manifests legados strippam sem erro). |
| 4 | **`restart` policy ausente** | ✅ **resolvido (Phase 1)** | `services[].restart` (enum) → `HostConfig.RestartPolicy`. |
| 5 | **Init / one-shot containers ausentes** | ⚪ fora de escopo | Migrations via tool `run_migrations` (shipado, PR #27). Outros one-shots: YAGNI. |
| 6 | **`size` / `fs` sem validação no schema** | ⚪ doc-only | `size` aceita formatos que o provider depois rejeita; `fs` aceita qualquer string que o Hetzner depois rejeita. Esta cheatsheet documenta os formatos válidos. |

### A armadilha do silent-strip

O comentário em `desired-state.ts:27-31` documenta a escolha: item schemas são
non-strict **para forward-compat** (manifesto escrito pra um parser mais novo
parseia num parser mais velho). O efeito colateral é que **todo typo ainda some
sem aviso**. Com a Phase 1, `command`/`restart`/`depends_on` agora são campos
reais — não evaporam mais; só typos genuínos (`commnd:`) e campos não-suportados
continuam sendo strippados em silêncio.

---

## Manifesto de exemplo (válido hoje)

```yaml
networks:
  - name: bevox-net
    ip_range: 10.0.0.0/16

servers:
  - name: harness-prod-1
    type: cx32
    location: nbg1
    network: bevox-net
    image: ubuntu-24.04

volumes:
  - name: pg-data
    size: "40G"          # "40G" é o formato seguro
    fs: ext4
    server: harness-prod-1
    # mount_path é advisory/doc-only (não enviado). Com automount o volume é
    # montado em /mnt/HC_Volume_<id>; o bind do service abaixo resolve esse path.
  - name: redis-data
    size: "5G"
    fs: ext4
    server: harness-prod-1

services:
  - name: postgres
    image: postgres:16-alpine
    replicas: 1
    command: ["postgres", "-c", "max_connections=200"]   # argv → Cmd (gap #1)
    restart: always                                       # gap #4
    env:
      POSTGRES_USER: bevox
      POSTGRES_PASSWORD: "secret:harness-pg-password"
      POSTGRES_DB: bevox_harness
    ports: ["5432"]
    # "<nome-de-volume>:<container_path>" → resolve para /mnt/HC_Volume_<id>:...
    volumes: ["pg-data:/var/lib/postgresql/data"]
  - name: redis
    image: redis:7-alpine
    replicas: 1
    command: ["redis-server", "--appendonly", "yes"]      # AOF sem imagem custom
    restart: always
    ports: ["6379"]
    volumes: ["redis-data:/data"]
  - name: bevox-harness
    image: ghcr.io/bevox/bevox-agent-harness:latest
    replicas: 1
    restart: on-failure
    depends_on: ["postgres", "redis"]                     # ordena depois das deps (gap #2)
    env:
      LOG_LEVEL: info
      DATABASE_URL: "secret:harness-database-url"
      OPENAI_API_KEY: "secret:openai-api-key"
    ports: ["8080"]

backups:
  - target: pg-data
    schedule: "0 3 * * *"
    retention: "7d"
```

---

## Como validar antes do apply

- O parser roda no `apply_manifest` / `diff` / `promote_manifest`. Um manifesto
  inválido falha com `ReconcileError("precondition")` citando `path: mensagem`
  e (em erro de YAML) `linha, coluna`.
- Para checar sem aplicar: `diff { source: "observed" }` parseia o manifesto e
  reporta o plano sem mutar nada.
- **Lembre-se do silent-strip:** campos suportados (`command`, `restart`,
  `depends_on`, etc.) são aplicados; mas um **typo** (`commnd:`) ou campo
  não-suportado dentro de um item ainda some sem aviso. Confira esta cheatsheet
  para saber o que é realmente suportado.
