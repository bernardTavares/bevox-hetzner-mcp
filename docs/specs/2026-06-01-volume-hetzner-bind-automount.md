# bevox-hetzner-mcp — Hetzner volume bind + automount (service persistence)

- **Data:** 2026-06-01
- **Status:** Aceita (2026-06-01) — §7 confirmado pelo operador: (1) automount, `mount_path` advisory; (2) formato `["<nome>:<container_path>"]`; (3) resolução via observed-store seam; (4) "converge no ciclo seguinte" aceitável (NÃO precisa ser atômico num apply).
- **Autor:** Bernard (bug report do deploy real) + Claude Code
- **Tipo:** Bug-fix (Bug 9, planner volume-bind validation) + feature (mount/persistência real no volume Hetzner). Aditivo; não altera contrato v1/v2.
- **Motivação:** No deploy real, nenhum formato de `service.volumes` liga um volume Hetzner declarado a um mount path no container end-to-end: nome puro → Docker 500 (mount path absoluto exigido); `name:path` ou `host:path` → planner rejeita (`plan.ts:162` usa a string inteira como nome de volume); e mesmo que passasse, o daemon não monta o volume Hetzner em lugar nenhum → dados iriam pro disco root.
- **Invariantes:** fail-safe (nenhuma remoção/reformat — automount formata SÓ o volume novo, 1x, semântica Hetzner; re-attach nunca reformata); idempotência (bind resolvido é estável ⇒ re-apply = no-op; `isConverged` compara o bind RESOLVIDO); secrets inalterados; StateEvent actor inalterado.

## 0. Escopo

Três peças, decisão de mount = **automount nativo Hetzner** (travada com o operador):

1. **plan.ts** — validação cross-kind no NOME do volume (split no `:`).
2. **volumeBody** — `automount: true` no create do volume (Hetzner formata o volume novo + monta em `/mnt/HC_Volume_<id>`).
3. **Resolução do bind** — o `service.volumes` `["<nome>:<container_path>"]` é resolvido, no apply do DockerProvider, para `/mnt/HC_Volume_<hcloud_id>:<container_path>` (o mount real do volume Hetzner), via um seam que consulta o observed-state do volume.

**Out-of-scope:** honrar o `mount_path` literal do manifesto (com automount o path é `/mnt/HC_Volume_<id>`; `mount_path` vira advisory/doc); bind de volume para server/outros kinds; volumes nomeados do Docker (não-Hetzner).

## 1. Bug 9 — planner valida o NOME, não a string inteira

`plan.ts:162` (deriva o dep cross-kind de `svc.volumes`):
```ts
// Antes: trata a entrada inteira como nome de volume
...(svc.volumes ?? []).map((vol) => key("volume", vol)),
// Depois: o dep é o NOME do volume (segmento antes do primeiro ':')
...(svc.volumes ?? []).map((vol) => key("volume", vol.split(":")[0] ?? vol)),
```
Retro-compatível: `"data".split(":")[0]` = `"data"` (fixtures que usam `volumes: ["data"]` seguem válidas). Aceita `"<nome>:<container_path>"`.

## 2. automount no create do volume

`volumeBody` (`hetzner-cloud.ts:336`): adicionar `automount: true` ao body do `POST /volumes` (já manda `format`). Semântica Hetzner: o volume NOVO é formatado 1x e montado em `/mnt/HC_Volume_<id>`; re-attach/re-create idempotente **nunca reformata** (segurança de dados garantida pela Hetzner, não por mkfs nosso). `mount_path` do manifesto não é enviado (advisory).

## 3. Resolução do bind (a peça central)

O container precisa do mount REAL do volume Hetzner. Com automount esse path é `/mnt/HC_Volume_<hcloud_id>`, conhecido só APÓS o create (Hetzner atribui o id). Logo a resolução é no apply, a partir do observed-state.

- DockerProvider ganha seam OPCIONAL aditivo:
  ```ts
  readonly resolveVolumeMount?: (volumeName: string) => Promise<string | undefined>;
  ```
- `createContainerBody`: para cada entrada de `svc.volumes`:
  - se for `"<nome>:<container_path>"` com `<nome>` NÃO absoluto (não começa com `/`) E `resolveVolumeMount(nome)` retorna um mount → bind `"<mount>:<container_path>"`;
  - senão (sem resolver, não resolvível, ou já host-path absoluto) → passa AS-IS (back-compat com fixtures e binds host-path explícitos).
- `isConverged`: compara o bind **resolvido** (resolve do mesmo jeito) ⇒ re-apply estável (não flapa). O mount resolvido é estável após o create (hcloud_id fixo) ⇒ idempotência preservada.
- **Composition root** (`entrypoint-wiring.ts`): liga `resolveVolumeMount(name)` a uma consulta do observed-store de volumes — `getObservedState(pool, "volume")` → acha o volume por nome → `/mnt/HC_Volume_<hcloud_id>`. Ausente em testes-em-isolamento ⇒ comportamento AS-IS (back-compat).

## 4. Testes (TDD, fakes-only)

| Layer | Arquivo | Cobertura |
|---|---|---|
| Bug 9 plan | `plan.test.ts` | service `volumes: ["pg-data:/var/lib/pg"]` valida contra volume declarado `pg-data`; `["data"]` segue válido (retro-compat); nome não declarado → precondition |
| automount | `hetzner-cloud.test.ts` + fake | `POST /volumes` body inclui `automount: true` (+ `format`) |
| bind resolve | `docker.test.ts` | com `resolveVolumeMount` retornando `/mnt/HC_Volume_42`, `["pg-data:/var/lib/pg"]` → `HostConfig.Binds = ["/mnt/HC_Volume_42:/var/lib/pg"]`; sem resolver → AS-IS; host-path absoluto → AS-IS; `isConverged` estável (re-apply no-op) |
| resolver wiring | `entrypoint-wiring*.test.ts` ou unit do resolver | nome → `/mnt/HC_Volume_<hcloud_id>` via observed-store; nome ausente → undefined (bind AS-IS) |
| idempotency property | `idempotency.property.test.ts` | manifesto com volume+service(bind resolvido) converge; ciclo 2 no-op |

## 5. Acceptance criteria

- [ ] typecheck sem novos erros; suíte verde.
- [ ] Bug 9: planner valida no nome; `name:container_path` aceito; retro-compat com `["data"]`.
- [ ] volume create manda `automount:true`; nunca reformata (semântica Hetzner; documentado).
- [ ] bind resolvido `/mnt/HC_Volume_<id>:<path>` quando o volume é declarado/observado; AS-IS senão; `isConverged` estável (re-apply no-op).
- [ ] Idempotency property cobre o caminho; secret golden byte-idêntico.
- [ ] CHANGELOG + cheatsheet/docs: formato `service.volumes: ["<nome-de-volume>:<container_path>"]`, `mount_path` advisory, persistência no volume Hetzner.

## 6. Riscos

- **Idempotência do bind resolvido (alto):** `isConverged` DEVE resolver o bind do mesmo jeito que `createContainerBody`, senão re-apply flapa (re-create infinito). Teste explícito de re-apply no-op.
- **Segurança de dados:** automount formata SÓ o volume novo (Hetzner). Nenhum mkfs nosso ⇒ sem risco de reformatar dados. (É por isso que escolhemos automount sobre mkfs-via-SSH.)
- **Cross-provider via observed-store:** o resolver lê o observed-state do volume (não acopla docker↔hetzner provider). Se o volume ainda não foi observado (1º ciclo, antes do create persistir), resolve undefined → bind AS-IS → o próximo ciclo reconcilia com o mount resolvido. Aceitável (converge no ciclo seguinte; ordem de dependência volume→service já garante volume primeiro).
- **mount_path advisory:** operadores podem esperar que `mount_path` seja honrado. Documentar que com automount o path é `/mnt/HC_Volume_<id>` e `mount_path` é doc-only (ou follow-up: symlink via user_data).

## 7. Decisões a confirmar no review

1. **Mount = automount Hetzner** (travado) — path `/mnt/HC_Volume_<id>`, `mount_path` advisory. OK?
2. **Formato `service.volumes` = `["<nome>:<container_path>"]`** (nome do volume declarado : path no container). OK? (host-path absoluto continua passando AS-IS pra binds não-Hetzner.)
3. **Resolução via observed-store** (seam no DockerProvider, wired no composition root) — vs threading no reconciler. Proposto: seam + observed-store (menos invasivo). OK?
4. **1º ciclo:** se o volume ainda não está observado, o bind vai AS-IS e converge no ciclo seguinte (não num único apply). Aceitável pro go-live, ou precisa ser atômico num apply?
