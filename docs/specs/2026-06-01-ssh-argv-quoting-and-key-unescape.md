# bevox-hetzner-mcp — SSH argv quoting + SSH_PRIVATE_KEY unescape (deploy bug fixes)

- **Data:** 2026-06-01
- **Status:** Aceita (2026-06-01)
- **Autor:** Bernard (bug report do deploy real) + Claude Code
- **Tipo:** Bug-fix de correção (+ hardening) nos providers SSH/config v1. **Não** altera contrato de wire, error codes, nem invariantes; restaura o comportamento pretendido do transporte SSH.
- **Motivação concreta:** Durante o go-live real do bevox-harness, `apply_manifest` com `services` falha no transporte Docker-over-SSH. Dois bugs distintos bloqueiam o caminho (um já com workaround frágil em `dist/`, não-fonte).
- **Invariantes v1 preservadas:** fail-safe nunca fail-deleting (não toca caminho de erro destrutivo); idempotência (transporte é meio, não muda convergência); **secrets resolvidos só em apply** — o corpo da request (que pode carregar secret resolvido) já viaja por **stdin**, nunca em argv (`ssh-transports.ts:152`), e essa garantia é mantida; StateEvent actor inalterado.

## 0. Escopo

| # | Bug | Sintoma | Fix | Arquivo |
|---|-----|---------|-----|---------|
| 1 | `SSH_PRIVATE_KEY` com `\n` literal não é des-escapado | OpenSSH recusa o keyfile temp (libcrypto), apply SSH falha no boot do transporte | Zod `.transform` em `config.ts`: `\\n`→`\n` + garante trailing `\n` | `core/src/config.ts` |
| 2 | argv remoto não é shell-quotado (**blocker atual**) | `curl: option -w: requires parameter` + `bash: …%{http_code}: command not found` | `shellEscape` cada elemento de `remoteArgv` em `buildSshArgs` | `core/src/providers/ssh-exec.ts` |
| 3 | `.env.example` / runbook não explicam SSH_HOST/USER/KEY + `ssh_keys` no manifesto | Operador não sabe popular as credenciais SSH | Docs (operacional, spec-exempt; viaja junto) | `core/.env.example`, `deploy/` |

**Out-of-scope:** unescape em `RESTIC_PASSWORD` ou outros secrets de uma linha (uma senha pode conter legitimamente a sequência `\n` de 2 chars; unescape a corromperia — só PEM multi-linha precisa). Nenhuma mudança no `HTTP_MARKER` em si (ele funciona assim que o quoting estiver correto). Nenhuma nova dependência.

## 1. Bug 2 — SSH argv shell-quoting (blocker)

### 1.1 Causa-raiz

`buildSshArgs` (`ssh-exec.ts:208-240`) termina com:

```ts
// The remote command is a literal argv vector after `--`. No shell.   ← PREMISSA ERRADA
args.push("--", ...remoteArgv);
```

O comentário está **incorreto**. O cliente `ssh` do sistema NÃO entrega um vetor argv literal ao remoto: ele **junta com espaços** tudo após o host num único comando e o `sshd` remoto executa `$SHELL -c "<comando-juntado>"`. O shell remoto então re-parseia a string.

O `-w` da request Docker é `` `\n${HTTP_MARKER}%{http_code}` `` (`ssh-transports.ts:163`) — onde `\n` é um **newline real**. Ao juntar e re-parsear no shell remoto, o newline quebra o comando em duas linhas:
- linha 1 termina em `-w` (sem valor) → `curl: option -w: requires parameter`;
- linha 2 vira `__BEVOX_HTTP__%{http_code}` → `command not found`.

Tokens com espaço, `$VAR`, `%{}`, aspas, etc. sofrem o mesmo destino.

### 1.2 Fix

Shell-escapar cada elemento de `remoteArgv` antes do append, com single-quote (a forma POSIX que neutraliza TODO metachar, inclusive newline):

```ts
/** POSIX single-quote escaping: wrap in '…', and close/reopen around any
 *  embedded single-quote ('\''). Neutralises newline, space, $, %{…}, quotes. */
export function _shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
```

e em `buildSshArgs`:

```ts
// ssh joins the post-host args with spaces and the remote sshd runs them via
// `$SHELL -c`; each token MUST be shell-escaped so the remote shell re-parses
// it back to the exact original argv element (newline / $ / %{} / quotes safe).
args.push("--", ...remoteArgv.map(_shellEscape));
```

(Prefixo `_` por ser export test-only — Rule 8 `esm-nodenext`. Produção consome via `buildSshArgs`.)

### 1.3 Segurança

O corpo da request (que pode conter secret resolvido em create) já viaja por **stdin** (`ssh-transports.ts:152,166-178` — `--data-binary @-` + `stdin: payload`), nunca em argv. Logo este bug é **corrupção de comando, não vazamento de secret em argv**. O fix fecha a superfície de re-interpretação de metachar pelo shell remoto (defense-in-depth) sem mudar o caminho de secret.

## 2. Bug 1 — `SSH_PRIVATE_KEY` `\n`-unescape

### 2.1 Causa-raiz

`config.ts:124` declara `SSH_PRIVATE_KEY: requiredSecret("SSH_PRIVATE_KEY")` (`z.string().trim().min(1)`). O operador escreve a PEM com `\n` literais no `.env` (Node `--env-file` não interpola/des-escapa). Os 2 chars `\`+`n` chegam à `process.env`, o keyfile temp sai com `\n` literais, e o OpenSSH recusa (erro libcrypto).

### 2.2 Fix

`.transform` encadeado **depois** de `requiredSecret` (o `.trim()` roda na forma escapada — inócuo a `\n` literais — e o trailing `\n` que adicionamos sobrevive):

```ts
SSH_PRIVATE_KEY: requiredSecret("SSH_PRIVATE_KEY").transform((s) => {
  const pem = s.replace(/\\n/g, "\n");      // \n literal → newline real
  return pem.endsWith("\n") ? pem : pem + "\n"; // OpenSSH exige trailing newline
}),
```

Remove o workaround atual de `dist/providers/ssh-exec.js:168` (não-fonte): com o valor já normalizado em config, `ssh-exec.ts` consome o PEM correto sem mudança. Uma PEM já-multilinha (newlines reais) é idempotente sob o transform (sem `\n` literal a trocar; trailing garantido).

## 3. Bug 3 — docs (operacional, spec-exempt)

- `core/.env.example`: placeholder de `SSH_PRIVATE_KEY` deixando explícita a convenção `\n`-escapada de uma linha (pós-fix); nota em `SSH_HOST`/`SSH_USER` de que precisam de IP/usuário reais.
- `deploy/` runbook ou README: workflow — (1) gerar keypair, cadastrar a **public** key nas Hetzner Cloud SSH Keys; (2) referenciar o nome em `servers[].ssh_keys: ["<name>"]` no manifesto (Hetzner injeta na criação do server); (3) popular `SSH_PRIVATE_KEY` no `.env` (formato `\n`-escapado).

## 4. Testes (TDD, fakes-only)

| Layer | Arquivo | Cobertura |
|---|---|---|
| config unescape | `core/src/config.test.ts` (EXTEND ou NEW) | `SSH_PRIVATE_KEY` com `\n` literais → newlines reais; trailing `\n` garantido; PEM já-multilinha idempotente; `RESTIC_PASSWORD` **não** sofre unescape (regressão de escopo) |
| shellEscape unit | `core/src/providers/ssh-exec.test.ts` (EXTEND) | `_shellEscape` para: newline, `%{http_code}`, `$VAR`, espaço, aspa simples, string vazia — cada um wrapped e neutralizado |
| buildSshArgs | `core/src/providers/ssh-exec.test.ts` (EXTEND) | cada elemento de `remoteArgv` aparece escapado após `--`; o argv não-remoto (flags ssh, host) inalterado; round-trip: re-parsear via `/bin/sh -c` (ou parser POSIX) devolve os tokens originais |
| transporte (regressão) | `core/src/providers/ssh-transports.test.ts` | o curl Docker com `-w \n__BEVOX_HTTP__%{http_code}` produz argv escapado; parsing de status/body inalterado; secret continua só em stdin |
| `@live` (manual) | `core/test/live/*.live.test.ts` | pós-merge: apply real de um service mínimo (`nginx:alpine`) contra `SSH_HOST` real → container rodando |

Sentinela de secret e golden `secret-apply.test.ts` permanecem byte-idênticos (o caminho de secret não muda).

## 5. Validação de fix (pós-merge, operacional)

1. `npm --prefix core run build` (o fix de fonte substitui o patch frágil do `dist/`).
2. `sudo systemctl restart bevox-daemon.service` → boot limpo.
3. Apply de um manifesto de service mínimo (`nginx:alpine`, 1 réplica) contra `SSH_HOST` real → `status: applied`, container rodando.

## 6. Acceptance criteria

- [ ] `npm --prefix core run typecheck` sem novos erros.
- [ ] `npm --prefix core test` verde.
- [ ] `_shellEscape` neutraliza newline/`$`/`%{}`/espaço/aspa; `buildSshArgs` escapa cada elemento de `remoteArgv`; comentário "literal argv vector / no shell" corrigido.
- [ ] `SSH_PRIVATE_KEY` des-escapa `\n` e garante trailing newline; `RESTIC_PASSWORD` inalterado.
- [ ] `dist/` patch removido (fonte cobre o fix); nenhum secret em argv (corpo segue em stdin).
- [ ] `.env.example` + runbook documentam o workflow SSH (Bug 3).
- [ ] `CHANGELOG.md` entrada `[Unreleased]`.

## 7. Decisões registradas

| Decisão | Escolha | Razão |
|---|---|---|
| Bug 1 local | `config.ts` `.transform` | fonte única; valor em memória é a PEM real; remove patch do `dist/` |
| Bug 2 estratégia | escapar cada elemento (`remoteArgv.map(_shellEscape)`) | preserva semântica argv; remote shell re-parseia nos tokens originais |
| `RESTIC_PASSWORD` unescape | **não** | senha de uma linha pode conter `\n` literal legítimo; só PEM precisa |
| Bug 3 docs | mesma branch/PR | fecha o go-live de uma vez; docs são spec-exempt |
