---
name: orquestar
description: Planificar con el modelo principal y delegar la ejecución a modelos más baratos (DeepSeek en Command Code, Gemini en Antigravity) o a subagentes nativos usando el comando orq. Úsala en repos git cuando la tarea tiene sustancia (una feature, un refactor, una fase de un plan, tests o documentación de más de unas pocas líneas, o explorar un repo grande), aunque el usuario no mencione delegar, orq, Command Code, Antigravity, DeepSeek ni Gemini. No la uses para cambios triviales (un archivo, pocas líneas), preguntas conceptuales, depuración interactiva ni en repos donde orq estado diga que el orquestador está desactivado.
---

# Orquestar: planificar, delegar y revisar

Tu rol en esta sesión es planificar, elegir el rol de cada subtarea, delegar y revisar.
Como regla, **no editas código del repo tú mismo**: si reescribes lo que hizo otro modelo, el ahorro de delegar desaparece. Las excepciones están acotadas abajo (cambios triviales y ajustes menores en la revisión).

## Cuándo no delegar

- **Cambio trivial fuera de un plan** (≤ 10 líneas en un archivo: un typo, un import, un valor): hazlo directamente. Delegar cuesta más (prompt, worktree, revisión) que hacerlo.
- **Repo desactivado:** si `orq estado` dice que el orquestador está desactivado, trabaja normalmente sin esta skill.

## Flujo

0. **Estado del repo.** Antes de planificar, ejecuta `orq estado`. Es la fuente de verdad: si el repo es sensible (modelos delegados bloqueados: trabajas solo con subagentes nativos), los roles con sus valores efectivos y cuándo usar cada uno, los modelos que permite cada rol con sus fortalezas, qué ejecutores están disponibles, el sandbox, los comandos `preparar`/`validar` del repo, las tareas abiertas y los worktrees sin integrar.
1. **Plan.** Explora lo justo (usa el subagente `Explore`, que corre en Haiku) y escribe `PLAN.md` dividido en fases. Cada fase declara: objetivo, archivos que toca, criterios de aceptación y cómo se verifica (tests o comandos). Muéstrale el plan al usuario antes de delegar.
2. **Elegir rol (y, si hace falta, modelo).** Para cada fase o subtarea, elige un rol de los que lista `orq estado`. Por defecto `orq` usa el modelo primario del rol y decide el effort. Puedes pedir otro modelo de los permitidos del rol con `--modelo <id>` cuando haya un motivo concreto:
   - un intento con el primario falló por falta de capacidad (no por un prompt ambiguo): reintenta con `--continuar <tarea> --modelo antigravity/gemini-4-neon`;
   - la tarea encaja con las fortalezas que `orq estado` atribuye a otro modelo.

   Los modelos de Antigravity tardan unos 40 s solo en arrancar: no los uses para tareas mínimas. Si su ejecutor aparece como BLOQUEADO en `orq estado`, no los pidas.
3. **Delegar.** Llama al router con un prompt autocontenido por stdin:

   ```bash
   orq delegar implementar --fase "Fase 2" <<'PROMPT'
   Objetivo: ...
   Archivos a modificar: ...
   Criterios de aceptación: ...
   Convenciones a respetar: ...
   PROMPT
   ```

   El modelo delegado **no ve esta conversación ni tus skills** (salvo las que `orq` pase con `--skill`). El prompt debe incluir rutas, criterios de aceptación y las reglas de estilo que apliquen. Una fase por delegación.

   Una delegación puede tardar varios minutos: ejecútala con el timeout máximo de la herramienta Bash o en segundo plano, y espera a que termine. Si igual se corta, queda registrada como interrumpida y puedes seguirla con `--continuar`.
4. **Revisar.** `orq` imprime un resumen con el id del intento, la tarea, el worktree, los archivos tocados, el resultado de `validar` (si el repo lo declara) y alertas. Revisa el diff con el comando que indica (`git diff <base>...<rama>`) y compáralo contra `PLAN.md`.

   Para correr tests, builds o scripts sobre ese código usa **`orq validar <tarea>`** (los comandos `validar` del repo) u **`orq validar <tarea> -- <comando>`**: corren dentro del sandbox y sin secretos. **No ejecutes en tu shell código del worktree** (`npm test`, scripts, builds): lo escribió otro modelo y correría con todos los permisos del usuario.
5. **Registrar la revisión.** Siempre, después de cada revisión:

   `<id>` es el id del intento que imprimió el resumen (no el de la tarea, salvo que sea el primer intento).

   ```bash
   orq revision <id> aprobado --nota "breve"
   orq revision <id> ajustado --nota "qué ajustaste"
   orq revision <id> corregido --nota "qué falló"
   ```

   - `ajustado`: lo que falla es trivial (≤ 10 líneas en ≤ 2 archivos: un typo, un import, un nombre, formato). Corrígelo tú en el worktree y haz commit en su rama **sin hooks** (el agente pudo plantarlos en el worktree): `git -C <worktree> -c core.hooksPath=/dev/null commit --no-verify -am "ajuste: ..."`. Regístralo así: cuenta como aprobado, y el scorecard mide cuántas veces hace falta.
   - `corregido`: cualquier otra falla. No la arregles tú: reintenta.
6. **Si no se aprueba,** reintenta con `orq delegar <rol> --continuar <tarea>` y un prompt de corrección acotado a lo que falló (no repitas la tarea completa). `orq` calcula el intento, reutiliza el worktree de la tarea y sube el effort. No empieces una tarea nueva para reintentar la misma subtarea: no contaría el intento.
7. **Si `orq` responde con código 4 (escalar),** se agotaron los intentos con los modelos delegados: pasa la tarea al subagente nativo que indica, dándole el worktree para que continúe ahí.
8. **Integrar.** Cuando una fase está aprobada, propón al usuario integrarla con `git merge --no-ff <rama>`. Después de integrar, `orq limpiar` elimina los worktrees ya integrados. No integres sin su aprobación.

## Códigos de salida de `orq delegar`

| Código | Significa | Qué haces |
| --- | --- | --- |
| 0 | Terminó | Revisa |
| 1 | El modelo delegado falló, no respondió, o orq falló a mitad de camino (el resumen dice cuál) | Si fue el modelo, trátalo como no aprobado y reintenta con `--continuar`; si fue orq, avisa al usuario |
| 2 | Uso o configuración (rol o tarea desconocidos, prompt vacío, ejecutor no instalado, registro inválido) | Corrige el comando; si es configuración, avisa al usuario |
| 3 | Bloqueado (fuera de whitelist, modelo retirado, repo sensible, desactivado, sin sandbox obligatorio) | No busques otra vía: usa el subagente nativo que indica o trabaja sin delegar |
| 4 | Escalar | Pasa la tarea al subagente nativo con su worktree |
| 5 | Integridad: el modelo delegado tocó algo fuera de su worktree (configuración de git, permisos, el checkout principal) | **Detente y avisa al usuario** con las líneas de `⚠ INTEGRIDAD`. No integres, no reintentes, no escales |
| 124 | Timeout | Trátalo como no aprobado: reintenta con una tarea más acotada |

## Reglas

- Nunca llames a `cmd` ni a `agy` directamente: el único camino a Command Code y Antigravity es `orq delegar`.
- Nunca ejecutes fuera del sandbox código que escribió un modelo delegado: usa `orq validar`.
- Nunca edites el registro global (`~/.claude/orquestador/models.yaml`) ni `.claude/orquestador.yaml` del repo. Si el scorecard sugiere cambios, propónlos al usuario como diff.
- Plan, revisión de diffs, seguridad, auditorías y migraciones de datos no se delegan.
- Si tres delegaciones seguidas de una misma fase no se aprueban, detente y consulta al usuario.
- Si el resumen avisa que el rol declara skills que no se pasaron al modelo delegado, resume en el prompt las reglas relevantes de esas skills.
- Si una alerta dice que se excedió el límite de archivos, que se tocaron rutas fuera del rol o configuración de agentes/CI, trátalo como revisión no aprobada salvo que el cambio esté justificado por el plan.
- Si `validar` falla, la revisión no se aprueba salvo que la falla no tenga relación con la tarea (y entonces dilo en la nota).

## Revisión mensual

Ejecuta `orq scorecard --desde <fecha>` (agrega todos los repos; `--aqui` filtra el actual) y presenta al usuario las métricas por tarea (cuántas se resuelven al primer intento, cuántas escalan, tokens por tarea) y las sugerencias (promover, degradar o sumar un segundo modelo) como un diff propuesto del registro global. El usuario aprueba o rechaza cada cambio.
