# Orquestador multimodelo 0.4 · instalación global

Claude Code con Opus planifica, elige un rol para cada subtarea y revisa el resultado. La ejecución la hace
un modelo más barato, dentro de un sandbox del sistema operativo: por defecto DeepSeek V4.1 Flash Fast a través
de Command Code, y opcionalmente Gemini a través de Antigravity CLI (`agy`). Si los intentos delegados de una
tarea fallan, `orq` la escala a un subagente nativo de Claude.

Se instala **una vez para tu usuario** y funciona en todos tus repos, sin copiar nada dentro de cada uno.

## Requisitos

- macOS o Linux, con Node.js 20 o superior y git.
- Claude Code.
- Command Code 0.26.21 o superior, con sesión iniciada (`npm i -g command-code@latest`). Para medir tokens hace falta la 1.0 o superior.
- Opcional, para los modelos `antigravity/*`: Antigravity CLI 1.5.4 o superior, autenticado (ver [Antigravity](#antigravity-agy)).
- En Linux, para el sandbox: bubblewrap (`bwrap`). En macOS se usa `sandbox-exec`, que viene con el sistema.

## Instalación

### En un comando (macOS y Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/allopze/omg/main/instalar.sh | bash
```

Puedes pasar opciones al instalador (por ejemplo `--simular`, `--forzar` o fijar una versión con `ORQ_REF`):

```bash
curl -fsSL https://raw.githubusercontent.com/allopze/omg/main/instalar.sh | bash -s -- --simular
ORQ_REF=v0.4.1 curl -fsSL https://raw.githubusercontent.com/allopze/omg/main/instalar.sh | bash
```

Para instalarlo o actualizarlo en un servidor remoto por SSH desde tu máquina:

```bash
ssh tu-servidor "bash -lc 'curl -fsSL https://raw.githubusercontent.com/allopze/omg/main/instalar.sh | bash'"
```

### Alternativa con `npx` o repositorio clonado

```bash
npx -y github:allopze/omg#v0.4.1
```

O clonando manualmente:

```bash
git clone https://github.com/allopze/omg.git
cd omg
node instalar.mjs --simular    # opcional: muestra qué haría, sin tocar nada
node instalar.mjs
```

| Qué | Dónde |
| --- | --- |
| Código, registro global y logs | `~/.claude/orquestador/` |
| Skill `orquestar` | `~/.claude/skills/orquestar/` |
| Subagentes Explore, analista-sonnet, implementador-sonnet y documentador-haiku | `~/.claude/agents/` |
| Permisos (se fusionan con los tuyos y se respalda el original) | `~/.claude/settings.json` |
| Comando `orq` | `~/.local/bin/orq` |
| PATH, si hace falta (zsh, bash o fish) | `~/.zshrc`, `~/.bash_profile` (macOS) / `~/.bashrc` (Linux) o `~/.config/fish/conf.d/` |

El instalador respeta `CLAUDE_CONFIG_DIR` y termina con un diagnóstico (`orq doctor`).

### Actualizar

Vuelve a ejecutar el comando de instalación (`curl -fsSL https://raw.githubusercontent.com/allopze/omg/main/instalar.sh | bash`, `npx -y github:allopze/omg#<tag>` o `node instalar.mjs` tras `git pull`). El código nuevo se arma aparte (con sus dependencias) y recién entonces reemplaza al anterior: si `npm ci` falla, la instalación anterior queda intacta. Lo tuyo se conserva:

- **Registro (`models.yaml`):** si no lo modificaste desde que lo instaló el orquestador (o es la plantilla de la 0.2 sin tocar), se actualiza y el anterior queda en `models.yaml.anterior`. Si lo modificaste, se conserva y la versión del paquete queda en `models.yaml.nuevo` para que compares; las claves nuevas que no tengas toman su valor por defecto. Tus ajustes (`antigravity.permitir_cuenta_personal`, `sandbox.lectura_denegada`, `sandbox.lectura_extra`, `sandbox.escritura_extra`, `sandbox.preparar_con_credenciales`) y los resultados de la Fase 0 (`skills_compatibles`, `salida_json`) no cuentan como modificación y se conservan al actualizar.
- **Subagentes:** si modificaste alguno, se conserva (con `--forzar` se reemplaza).
- **Logs:** se conservan.
- **Permisos:** las reglas que una versión anterior agregó y ya no se usan se quitan.

Después de actualizar, corre la Fase 0 (`orq verificar --guardar` o `--capacidades`): comprueba que Command Code funciona dentro del sandbox y fija la detección de `--skill` y `--output-format json` (en `cmd >= 1.0.0`, `salida_json` se activa automáticamente si está en `null`).

### Desinstalar

```bash
curl -fsSL https://raw.githubusercontent.com/allopze/omg/main/instalar.sh | bash -s -- --desinstalar
# o si tienes el repo clonado:
node instalar.mjs --desinstalar
```

Quita solo lo que instaló:

- El código, la skill, el comando `orq` y la línea de PATH.
- Los subagentes que no modificaste.
- Las reglas de permisos que agregó. Si una regla ya existía en tu `settings.json` antes de instalar, se queda.

El registro y los logs se respaldan en `~/.claude/orquestador-respaldo-<fecha>/`, salvo que uses `--borrar-todo`.

## Fase 0

```bash
orq verificar --sin-llamadas                      # versiones, catálogos, autenticación y sandbox local, sin gastar créditos
orq verificar --capacidades --guardar             # solo sonda --skill y --output-format json en Command Code y los guarda
orq verificar --guardar                           # pruebas reales completas con prompts mínimos
orq verificar --modelo antigravity/gemini-4-neon  # solo ese modelo (cada llamada a agy tarda ~40 s)
orq verificar --ejecutor command_code --guardar   # solo ese ejecutor
```

La corrida con llamadas comprueba, por cada modelo de la whitelist:

1. Como rol de solo lectura, lee el repo y no escribe.
2. Acepta cada nivel de effort del registro (en Antigravity, cada slug de `agy models`).
3. Command Code: `--skill` carga el formato `SKILL.md` de Claude Code.
4. Command Code: `--output-format json` entrega la línea final con los tokens (agy siempre la entrega; con `cmd >= 1.0.0`, `salida_json` se activa automáticamente si su valor es `null`).
5. Funciona dentro del sandbox y el sandbox bloquea sus escrituras fuera del worktree.

Con `--guardar`, los resultados de 3 y 4 quedan en el registro (`skills_compatibles` y `salida_json`): solo cambian esas dos líneas, el resto del archivo queda igual. Con `--capacidades` puedes verificar únicamente esos dos flags en Command Code sin correr toda la matriz de modelos y efforts.

## Sandbox

Cada ejecución de un modelo delegado (Command Code o Antigravity), y cada comando `preparar`/`validar` de un repo, corre dentro de un sandbox del sistema operativo (`sandbox-exec` en macOS, `bwrap` en Linux). Ahí:

- **Escritura:** solo en el worktree de la tarea, en carpetas temporales, en cachés de paquetes y compilación (`~/.npm`, `~/.cache`, `~/Library/Caches`, `~/Library/Developer/Xcode/DerivedData`, `~/.pnpm-store`, `~/.cargo/registry`, `~/go/pkg/mod`, …) y en el estado de su propio ejecutor:
  - Command Code: `~/.commandcode`, salvo su configuración (`settings.json`, `AGENTS.md`, hooks, skills, agentes, comandos y MCP).
  - Antigravity: `~/.gemini/antigravity-cli` y `~/.gemini/antigravity`, salvo el `settings.json` y las skills de agy. El resto de `~/.gemini` (`GEMINI.md`, hooks, configuración de MCP) no es escribible.

  Un rol de solo lectura no puede escribir en el repo.
- **Temporales y Xcode en macOS:** cada ejecución tiene un temporal propio (`TMPDIR` en `orq-sb-*`; los temporales de otras delegaciones quedan cerrados). `/tmp` es escribible, salvo las carpetas de Claude Code (`/tmp/claude-<uid>`: scratchpads de sesiones y salidas de tareas que Opus lee), que no se pueden leer ni escribir. En macOS también se habilitan `DARWIN_USER_TEMP_DIR` y `DARWIN_USER_CACHE_DIR` (donde Foundation, CoreData, `actool` y `xcodebuild` escriben ignorando `$TMPDIR`), y dentro del sandbox `PATH` antepone wrappers de `xcodebuild` y `swift` que desactivan su `sandbox-exec` interno (`ENABLE_USER_SCRIPT_SANDBOXING=NO`, `-Xfrontend -disable-sandbox` / `--disable-sandbox`), porque macOS no permite sandboxes anidados. El proceso completo sigue confinado por el sandbox exterior de `orq` y recibe `ORQ_SANDBOX=1`.
- **Protegido:** el archivo `.git` del worktree (no puede apuntarlo a otro repo ni cambiar de rama).
- **Sin lectura, nunca:** `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.config/gcloud`, `~/.azure`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.git-credentials` y las credenciales de Claude Code.
- **Sin lectura, si lo pides (`lectura_denegada` y `lectura_extra`):** por ejemplo la carpeta donde guardas tus repos. El repo de la tarea, su worktree, el estado del ejecutor y cualquier ruta listada en `lectura_extra` (en modo solo lectura, p. ej. datos de referencia compartidos) se vuelven a abrir aunque estén dentro, y las credenciales siguen cerradas aunque estén dentro de algo legible. Se bloquea el contenido y el listado de carpetas; los metadatos siguen visibles, porque `git` y `realpath` los necesitan.
- **Sin secretos:** el modelo delegado y `validar` reciben el entorno sin `SSH_AUTH_SOCK` ni variables con pinta de secreto (`GH_TOKEN`, `AWS_*`, `ANTHROPIC_API_KEY`, `NPM_TOKEN`…; se conservan las que su ejecutor necesita, como `GEMINI_API_KEY`), no pueden conectarse a tus agentes de SSH o GPG, no leen tokens de registros de paquetes (`~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials`…) ni la autenticación del otro ejecutor. `preparar` (comandos tuyos) sí recibe el entorno completo; por defecto tampoco accede a `~/.ssh`, `~/.aws`, `~/.config/gh` ni `SSH_AUTH_SOCK` dentro del sandbox, salvo que habilites `sandbox.preparar_con_credenciales: true` (útil si instalas dependencias privadas).
- **Red:** abierta (el ejecutor la necesita para hablar con el modelo).

Se configura en `sandbox` del registro global (en la 0.3 estaba en `command_code.sandbox`, que se sigue aceptando):

```yaml
sandbox:
  modo: auto                        # auto | obligatorio | desactivado
  escritura_extra: []               # carpetas adicionales donde el ejecutor necesita escribir
  lectura_denegada: ["~/dev"]       # carpetas que no puede leer ([] desactiva la restricción)
  lectura_extra: []                 # carpetas de solo lectura dentro de lectura_denegada
  preparar_con_credenciales: false  # true: permite SSH y credenciales solo en preparar (deps privadas)
```

**Por defecto, `lectura_denegada` es `["~/dev"]`:** si guardas tus repos en otra carpeta, cámbialo. Un agente no necesita leer otros proyectos (si una tarea depende de una carpeta vecina, por ejemplo datos de referencia o un paquete enlazado con `file:../otro`, agrégala a `lectura_extra` o vacía `lectura_denegada`), y en las pruebas, Antigravity sin esa restricción exploró carpetas ajenas y el código del orquestador antes de hacer una tarea de una línea (289 s y más de 100 mil tokens, frente a 53 s y 28 mil con la restricción).

Con `auto`, si el sandbox no está disponible, cada resumen lo avisa y el modelo delegado corre con todos tus permisos. Con `obligatorio`, `orq delegar` se bloquea (código 3) antes de tocar nada.

Además del sandbox, `orq` compara antes y después de cada delegación:

- la configuración de git del repo y la global, y los hooks;
- tus permisos de Claude Code (globales y del repo), su `CLAUDE.md` global, sus skills, agentes, comandos y plugins, y el registro;
- la configuración de Command Code (incluida la confianza en hooks de proyecto, `taste`, `scripts` y las aprobaciones de quality gates);
- la de Antigravity y Gemini (`settings.json` de agy y de `~/.gemini`, `GEMINI.md`, hooks, MCP, skills globales y sus binarios);
- tus archivos de shell, el comando `orq` y el propio código del orquestador;
- el checkout principal y la rama del worktree.

Lo protegido se vuelve a comprobar después de `validar`, que ejecuta código del agente. Si el agente crea un repo git dentro del worktree o agrega submódulos, tampoco se commitea: git podría ejecutar su configuración fuera del sandbox.

Si algo de eso cambió, el resumen lo marca como `⚠ INTEGRIDAD` y `orq` sale con código 5. Si cambió la configuración de git, `orq` no vuelve a ejecutar git (ni `add` ni `commit`). Desde `orq`, git nunca ejecuta hooks, fsmonitor ni submódulos, y los commits no se firman con tu llave.

Pase lo que pase durante la delegación (un error de git, una señal que corta a `orq`), el intento queda registrado y el resumen se imprime con sus alertas.

## Antigravity (agy)

Los modelos `antigravity/*` del registro corren en [Antigravity CLI](https://antigravity.google/docs/cli/headless/) en modo headless. Vienen dos, en estado `en_prueba` y permitidos en todos los roles, aunque el primario de cada rol sigue siendo DeepSeek. Son Gemini 4 Neon (el más capaz para código y agentes) y Gemini 4 Hydrogen (rápido y el más barato por tarea). Se eligieron con los datos de noviembre de 2026 de [Artificial Analysis](https://artificialanalysis.ai/models/gemini-4-neon) y de la [página de modelos de Google DeepMind](https://deepmind.google/models/gemini/); según esos datos, Argon y 3.8 Flash rinden menos por costo. Opus los pide con `--modelo`:

```bash
orq delegar implementar --modelo antigravity/gemini-4-neon <<'PROMPT' ... PROMPT
orq delegar implementar --continuar <tarea> --modelo antigravity/gemini-4-neon <<'PROMPT' ... PROMPT   # reintento con otro modelo
```

Cada modelo traduce los niveles de effort de orq a slugs de `agy models` (agy codifica el effort en el slug):

```yaml
models:
  antigravity/gemini-4-neon:
    ejecutor: antigravity
    estado: en_prueba
    permisos: escritura
    repos_sensibles: prohibido
    efforts: { off: gemini-4-neon-low, low: gemini-4-neon-medium, high: gemini-4-neon-high, max: gemini-4-neon-xhigh }
```

Para sumar otro (Gemini 4 Argon, Gemini 3.8 Flash, los Orchestrator, Claude o GPT-OSS a través de agy), copia la entrada con los slugs que lista `agy models`, agrégalo a los `permitidos` de los roles y corre `orq verificar --modelo <id>`.

**Cómo lo invoca `orq`**, según lo verificado con agy 1.5.4:

- El prompt va por stdin como `stream-json` (sin límite de tamaño y sin quedar visible en `ps`), y la salida es `stream-json`. A Opus solo le llega la respuesta final y el resumen, con tokens de entrada, salida, razonamiento y caché.
- Roles de escritura: `--dangerously-skip-permissions`, dentro del sandbox de orq. En headless no hay a quién pedirle permiso.
- Roles de solo lectura: `--mode plan`, porque sin un modo explícito agy escribe en el workspace. Dentro del sandbox se agrega `--dangerously-skip-permissions`: en agy 1.5.14, el modo plan deniega cualquier comando (incluso `ls`) y la respuesta queda vacía. El sistema operativo garantiza que no escriba en el repo. Sin sandbox, queda solo `--mode plan`.
- Si agy termina sin respuesta (por ejemplo, porque un permiso se denegó en headless), `orq` lo reporta como falla con el motivo que agy imprime.
- agy no recibe skills por flag: si el rol declara skills, Opus resume sus reglas en el prompt.
- Cada llamada tarda unos 40 s en arrancar y carga unos 25 mil tokens de contexto propio de agy. No conviene usarlo para tareas mínimas.
- Si tu `~/.gemini/antigravity-cli/settings.json` tiene `allowNonWorkspaceAccess: true`, agy puede leer fuera del worktree. El sandbox impide que escriba afuera, pero para las lecturas usa `lectura_denegada` o pon esa opción en `false`.

**Autenticación.** `orq` detecta cómo está autenticado agy:

| Modo | Cómo se activa | Qué hace `orq` |
| --- | --- | --- |
| API key de AI Studio | `"modelProvider": "gemini"` en `~/.gemini/antigravity-cli/settings.json` y `GEMINI_API_KEY` | Lo usa |
| Proyecto de Google Cloud | `gcloud auth application-default login` y `AGY_ADC_AUTH=true` | Lo usa |
| Cuenta personal (el login de agy) | Lo normal tras `agy` interactivo | Lo permite por defecto (`antigravity.permitir_cuenta_personal: true`); con `false`, lo bloquea (código 3) |

Sobre la cuenta personal: el [FAQ de Antigravity](https://antigravity.google/docs/faq/) dice que envolver `agy` en otras aplicaciones *"is not supported under consumer plans"*, y sus [términos](https://antigravity.google/terms) prevén suspender las cuentas de Antigravity y Gemini CLI por usar software de terceros. Viene permitido por defecto; para bloquearlo, pon `permitir_cuenta_personal: false` (Opus tiene denegado editar el registro). `orq doctor` y `orq estado` muestran el modo detectado.

El instalador agrega reglas `deny` para que Claude Code no ejecute `agy` directamente ni edite el `settings.json` de agy: el único camino es `orq delegar`.

## Repos sensibles

Un repo es sensible si cumple cualquiera de estas condiciones:

- Su ruta o algún remoto de git coincide con los patrones de `repos_sensibles` en `~/.claude/orquestador/models.yaml`.
- Su `.claude/orquestador.yaml` dice `sensible: true` (`orq init --sensible`).

```yaml
repos_sensibles:
  rutas: ["~/dev/cliente-*"]
  remotos: ["*cliente*"]
```

Guarda tus patrones reales y rutas privadas únicamente en el `~/.claude/orquestador/models.yaml` de cada máquina (no en el repositorio): al actualizar, el instalador conserva los registros modificados por el usuario.

En un repo sensible, `orq delegar` bloquea Command Code (código 3) y explica por qué. Un repo puede marcarse como sensible, pero no puede desmarcarse si coincide con un patrón global.

## Ajustes por repo (opcional)

`orq init` crea `.claude/orquestador.yaml`. La whitelist, los modelos, el sandbox y los umbrales son globales: si el archivo intenta cambiarlos, `orq` lo rechaza. Ahí puedes:

```yaml
sensible: false
desactivado: false        # true: Opus trabaja sin delegar en este repo

# En cada worktree nuevo, antes de delegar (dentro del sandbox). ORQ_RAIZ es el checkout principal.
preparar:
  - npm ci
  - cp "$ORQ_RAIZ/.env" .env

# En el worktree, después de cada delegación de escritura (dentro del sandbox).
validar:
  - npm run lint
  - npm test --silent

roles:
  implementar:
    skills: [.claude/skills/convenciones-codigo]
    max_archivos: 25
```

- **`preparar`:** lo que dejen esos comandos sin ignorar en git (por ejemplo, un `.env` copiado) se queda en el worktree pero nunca se commitea. Usa comandos que no modifiquen archivos versionados (`npm ci`, no `npm install`). Si un comando falla, no se delega y el worktree se elimina.
- **`validar`:** el resultado (✔ o ✘, con las últimas líneas del comando que falló) aparece en el resumen, queda en el log y alimenta el scorecard. Lo que dejen sin ignorar en git se descarta.
- **`roles`:** puedes ajustar `effort`, `effort_reintento`, `skills`, `max_archivos` y `rutas_permitidas` de roles que ya existen.

Haz commit del archivo para que aplique a quien trabaje en el repo.

## Uso diario

Abre Claude Code con Opus en cualquier repo (`claude --model opus --effort high`) y pide la tarea normalmente. La skill `orquestar` se activa para tareas con sustancia (no para cambios triviales) y le indica a Opus el flujo:

1. Ejecuta `orq estado`: sensibilidad, roles efectivos y cuándo usar cada uno, sandbox, `preparar`/`validar`, tareas abiertas y worktrees pendientes.
2. Escribe `PLAN.md` por fases y te lo muestra.
3. Delega cada fase con `orq delegar <rol> <<'PROMPT' ... PROMPT`. Cada delegación de escritura queda commiteada en la rama `delegar/<tarea>` de su propio worktree. El prompt enviado se guarda en `~/.claude/orquestador/logs/salidas/<id>.prompt.md`.
4. Revisa el diff y el resultado de `validar`; si hace falta correr más tests, lo hace con `orq validar <tarea> [-- comando]`, dentro del sandbox, nunca en su propia shell. Registra el resultado con `orq revision <id del intento> aprobado|ajustado|corregido`. `ajustado` es para cuando Opus corrigió algo trivial en el worktree (cuenta como aprobado); ese commit lo hace sin hooks.
5. Si no se aprueba, reintenta con `orq delegar <rol> --continuar <tarea>`. `orq` calcula el intento, reutiliza el worktree y, cuando se agotan los intentos, indica a qué subagente escalar.
6. Te propone `git merge --no-ff <rama>` (requiere tu confirmación) y después `orq limpiar`.

### Dónde quedan los worktrees

Por defecto, en `<repo>/.claude/worktrees/<id>`, excluido en `.git/info/exclude` (tu `.gitignore` no se toca). Si jest, tsc, eslint u otra herramienta del checkout principal los recorre, ubícalos fuera del repo:

```yaml
worktrees:
  ubicacion: externa                    # repo | externa
  dir_externo: ~/.orquestador/worktrees # quedan en <dir_externo>/<repo>-<hash>/<id>
```

En ese caso, agrega `dir_externo` a `permissions.additionalDirectories` de Claude Code para que los subagentes puedan editar ahí sin pedirte permiso.

## Comandos

| Comando | Para qué |
| --- | --- |
| `orq delegar <rol> [--continuar <tarea> \| --worktree <ruta>] [--modelo ID] [--fase T] [--prompt-archivo R] [--dry-run]` | Delega al modelo del rol (lo usa Opus) |
| `orq revision <id del intento> aprobado\|ajustado\|corregido [--nota]` | Registra la revisión de ese intento |
| `orq validar <tarea> [-- comando]` | Corre los `validar` del repo (o el comando) en el worktree, dentro del sandbox |
| `orq ver <id\|tarea>` | Inspecciona el estado, prompt, log de salida y diff de una delegación o tarea |
| `orq estado [--resumen] [--json]` | Configuración efectiva del repo actual |
| `orq init [--sensible] [--forzar]` | Crea los ajustes del repo |
| `orq limpiar [--descartar <id\|ruta\|rama>] [--resueltas] [--logs] [--simular]` | Elimina worktrees integrados (o resueltos), poda logs antiguos o descarta uno sin integrar |
| `orq scorecard [--desde AAAA-MM-DD] [--aqui \| --repo N] [--detalle] [--json]` | Métricas por delegación y por tarea, con sugerencias |
| `orq verificar [--sin-llamadas] [--capacidades] [--guardar] [--modelo ID] [--ejecutor N]` | Fase 0 |
| `orq doctor` | Diagnóstico de la instalación y del repo |

Claude Code puede usar sin pedir permiso `delegar`, `revision`, `validar`, `estado`, `scorecard` y `doctor`. Para `limpiar`, `init` y `verificar` te pide confirmación.

### Códigos de salida de `orq delegar`

| Código | Significa |
| --- | --- |
| 0 | Terminó (revisa el resumen) |
| 1 | Falló: `preparar` falló, el modelo delegado terminó con error o sin respuesta, o `orq` falló a mitad de camino. El código propio del ejecutor (por ejemplo, 5 = rate limit en Command Code) queda en el resumen y en el log, nunca como código de `orq` |
| 2 | Uso o configuración: rol o tarea desconocidos, prompt vacío, registro inválido, ejecutor no instalado |
| 3 | Bloqueado: fuera de whitelist, modelo retirado, repo sensible, orquestador desactivado o sandbox obligatorio no disponible |
| 4 | Escalar: se agotaron los intentos con los modelos delegados |
| 5 | Integridad: el modelo delegado tocó algo fuera de su worktree. Opus se detiene y te avisa |
| 124 | Timeout: se terminó el ejecutor junto con los procesos que lanzó |
| 130 / 143 | Interrumpido por señal (`SIGINT` / `SIGTERM`): el intento queda registrado y puedes retomarlo con `--continuar <tarea>` (recupera `<tarea>` con `orq estado`) |

## Scorecard

`orq scorecard` agrega los logs de todos tus repos:

- **Por delegación** (modelo, rol, effort, skills): aprobación, aprobación al primer intento, ajustes manuales de Opus, tasa de `validar` OK, alertas, críticas, minutos y tokens promedio (`--detalle` muestra todas las columnas).
- **Por tarea** (por rol): cuántas se resuelven al primer intento, cuántas con reintento, cuántas escalan, intentos, minutos y tokens por tarea.
- **Totales:** minutos delegados, tokens, costo (si el ejecutor lo informa) y ajustes de Opus.
- **Sugerencias:** promover, degradar o sumar un segundo modelo según los umbrales del registro.

Los tokens se registran con `salida_json: true` (en `cmd >= 1.0.0` se activa automáticamente si `salida_json` es `null`; también lo fija `orq verificar --guardar`) o usando Antigravity. El costo del lado de Opus (planificar y revisar) no lo ve `orq`. Compáralo con el uso de Claude Code para saber si delegar compensa.

## Desde versiones anteriores

**Desde la 0.3:** el sandbox pasa de `command_code.sandbox` a `sandbox`, en la raíz del registro (el formato anterior se sigue aceptando). Los modelos de Antigravity aparecen en el registro nuevo; si conservas tu `models.yaml`, cópialos desde `models.yaml.nuevo`.

**Desde la 0.2:** si nunca modificaste tu `models.yaml`, el instalador lo actualiza solo.

- `--intento N` ya no existe: usa `--continuar <tarea>`. Los logs de la 0.2 se siguen leyendo, y sus reintentos se agrupan por worktree.
- `orq generar-skill` ya no existe: la skill no tiene partes generadas, y `orq estado` muestra los roles.

**Desde la 0.1 (instalación por repo):** en cada repo donde la instalaste, `orq doctor` te avisa. Para quitarla:

- borra `.claude/orquestador/`, `.claude/skills/orquestar/` y los cuatro agentes de `.claude/agents/`;
- quita sus reglas de `.claude/settings.json`.

Los logs de la 0.1 no se migran.

## Tests

```bash
npm test   # instala dependencias, 100+ tests del CLI (con cmd y agy falsos, sin gastar créditos) y 8 escenarios del instalador en un HOME aislado
```

O por separado: `cd orquestador && npm test` y `node --test pruebas/*.test.mjs`. Las pruebas del sandbox real corren solo en macOS. En Linux, las de `bwrap` cubren los argumentos que se construyen, no una ejecución real.

## Limitaciones conocidas

- **El sandbox deja la red abierta.** El ejecutor la necesita. Las credenciales de la lista, los tokens del entorno y los agentes de SSH/GPG quedan fuera de su alcance, pero en macOS el llavero (por ejemplo, un token de GitHub guardado por `git credential-osxkeychain`) sigue accesible para los procesos del sandbox. Con eso podría hacer `git push` por HTTPS. Las comprobaciones de integridad no detectan un push.
- **Las cachés de paquetes son escribibles**, para que `npm ci` y similares funcionen dentro del sandbox. Un agente podría dejar archivos ahí; los gestores de paquetes verifican la integridad de lo que leen de su caché, pero otras herramientas que guardan binarios en `~/.cache` o `~/Library/Caches` no siempre.
- **Las reglas `deny` de Claude Code no son un sandbox.** Bloquean `cmd ...` y `agy ...` directos, pero no un `bash -c "cmd ..."`. La skill le prohíbe a Opus saltarse `orq`.
- **Antigravity con tu cuenta personal** está fuera de lo que Google soporta en planes de consumo (ver [Antigravity](#antigravity-agy)). Con una API key o un proyecto de Google Cloud no hay ese problema, pero se paga por token.
- **Las reglas de `git diff`, `git log` y `git status`** quedan permitidas a nivel de usuario, o sea, en todos tus proyectos. Son de solo lectura.
- **El commit en el worktree se hace sin hooks.** Los tests y el lint se corren con `validar` (al delegar o con `orq validar`).
- **La limpieza del entorno es por nombre de variable.** Se quitan las que parecen secretos (`TOKEN`, `SECRET`, `API_KEY`, `_AUTH`…); un secreto en una variable con otro nombre llegaría al agente.
- **Un proceso que se desprende de su grupo** (un demonio que hace `setsid`) sobrevive al final de la delegación. Sigue dentro del sandbox, pero `orq` no puede terminarlo.
- **Windows no está soportado** por el instalador (el comando `orq` es un script `sh`).
