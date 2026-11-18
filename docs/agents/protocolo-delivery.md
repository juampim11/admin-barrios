# Protocolo de delivery — tamaño del trabajo, correcciones y seguridad

> Cómo se trabaja un encargo de punta a punta sin quemar contexto ni saltearse controles. Complementa
> `CLAUDE.md` §3.1 (qué personas se convocan en cada tarea), `docs/devops/02-sdlc-git-flow.md` (ramas y
> entornos) y `docs/agents/contrato-encargo.md` (formato del encargo y del reporte). Si algo de acá
> choca con `CLAUDE.md`, **manda `CLAUDE.md`**.

## 1. Tamaño del trabajo: los chicos van directo

Antes de convocar a nadie, se pone el trabajo en una de cuatro medidas. Cuánto equipo entra depende de
la medida, no del ánimo.

| Medida | Qué es | Cómo se hace |
|---|---|---|
| **S** | Una pregunta, ubicar un archivo, explicar algo | Se responde directo. Sin personas, sin revisor. |
| **M** | Un cambio chico y localizado: un texto, un bug de pocas líneas, un test | Directo: leer, cambiar, validar, PR. **Sin panel.** El `code-reviewer` solo si toca dinero, datos personales o permisos. |
| **L** | Una funcionalidad que cruza varios archivos | Alcance cerrado primero; persona de la capa que implementa; `code-reviewer` y `tester` antes del PR. |
| **XL** | Dinero, datos personales, permisos, RLS, migraciones, infraestructura, cambios transversales | Todo lo de L, más `security-engineer` (**obligatorio**, CLAUDE.md §3.1) y aviso al titular antes de cerrar. |

Reglas de ruteo:
- **No se delega lo que se resuelve con una o dos búsquedas o una lectura.** Pasado ese punto, la
  ubicación del código se delega a una búsqueda barata en vez de seguir grepeando a mano.
- **Una corrección de algo que ya existe, con una prueba que decide sola si pasó** (un test, el
  typecheck, un script), es un arreglo chico. **Crear algo nuevo desde cero no lo es**: no tiene
  comportamiento previo y su aceptación es mirarlo; va como M o L, con revisión.
- Un pedido que mezcla intenciones se hace en orden: entender → fijar alcance → implementar → revisar →
  versionar.
- **Versionar** (rama, commit, push, PR) solo cuando se pide; nunca implícito.

### Tramos
Para el implementador, los pasos se cuentan como llamadas a herramientas, no como viñetas: **la
validación y el reporte final cuentan como pasos**. Un encargo de unos 25 pasos o más se parte en
tramos encadenados (`docs/agents/contrato-encargo.md`), cada uno revisable y testeable por separado y en
orden de dependencia.

## 2. Bucle de corrección

Arranca cuando el `code-reviewer` devuelve **cambios pedidos**.

1. Entran **solo los hallazgos bloqueantes y mayores**. Un menor entra únicamente si está en un archivo
   que ya se toca y arreglarlo es de bajo riesgo. Las notas no entran salvo que el titular lo pida.
2. **Sin alcance nuevo.** Lo que el revisor observa fuera del encargo se anota, no se arregla ahí.
3. La corrección vuelve al implementador con: referencia al encargo, alcance original, cada hallazgo
   (severidad, archivo, problema, arreglo exigido), lo que se deja afuera y la validación a repetir.
4. **La re-revisión mira solo el diff de la corrección**, no el cambio entero.
5. **Máximo 2 vueltas.** A la tercera se frena y se avisa al titular: es señal de que el encargo o el
   diseño están mal, no el código.
6. Si el revisor devuelve **bloqueado**, se informa qué falta (contexto, diff, estado del repo) y se
   pide; no se revisa a ciegas.
7. Con **aprobado** o **aprobado con notas** se sigue al PR; las notas van al PR, no se arreglan por
   las dudas.

### Si el trabajo se corta a la mitad
No se rehace nada. Se reporta, con la lista de pasos como fuente de verdad: **hecho** (los pasos
terminados y los archivos tocados), **pendiente** (lo que no se alcanzó, con el detalle para seguir) y
**validación sin correr**. A los ~75 % del presupuesto sin haber terminado, se deja de implementar y
se valida lo que ya existe: un parcial validado vale más que más código sin validar. La continuación
recibe solo lo pendiente y su validación.

## 3. Seguridad y condiciones de freno

### Estado del repo antes de empezar (si el trabajo no es trivial)
```
git branch --show-current
git status --short
git diff --name-only <base>...HEAD
git diff --cached --name-only
git log --oneline -5
```
Se anota: rama, base elegida (por defecto `origin/main`) y por qué, si hay cambios sin commitear
(propios o ajenos) y el riesgo (bajo / medio / alto). **Los cambios ajenos se preservan**: no se
revierten ni se pisan.

### Se frena antes de editar cuando
- los archivos a tocar tienen cambios ajenos que chocan con el encargo;
- hay cambios en el staging fuera del encargo;
- no existe la base del diff, el HEAD está desprendido o hay conflictos;
- la validación que corresponde **ya falla** por una causa relevante.

### Se frena en cualquier momento cuando
- el encargo es insuficiente, ambiguo o contradictorio, o le falta una sección del contrato;
- hace falta tocar algo fuera del alcance aprobado;
- aparece un cambio no previsto de **esquema, migración, secreto, infraestructura o permisos**;
- hace falta abrir `.env*`, `privado/` o datos reales;
- una validación falla por una causa que no se entiende;
- el CI queda rojo **dos veces seguidas** por una causa ajena al cambio.

### Operaciones que no se hacen (y que los frenos del repo cortan)
`git reset --hard`, `git clean -f`, `rm -rf` sobre el repo, `drop table` / `delete from` / `truncate`,
`git rebase`, `git push --force`, `git push --delete`, merge, crear/borrar/subir tags (listar con `git tag -l` sí se puede), release, y cualquier comando de despliegue o de
infraestructura. Ver «Frenos por mecanismo» en `CLAUDE.md`.

### Secretos
Antes de cerrar un cambio o de commitear se revisa el diff buscando `token`, `secret`, `password`,
`apikey`, `api_key`, `bearer`, `credential`, `private_key`. Si aparece algo: se frena, se informa el
**archivo y el contexto sin copiar el valor** y no se commitea.

### Procesos que no terminan solos
Un proceso que sigue corriendo hasta que alguien lo corta (un servidor de desarrollo, un `watch`) no
puede dejar a la sesión esperando: se lanza en segundo plano, se **confirma por su propia salida** que
arrancó (no por lo que devuelve el lanzador), se anota cómo mirarlo y cómo pararlo, y no se deja
ninguno corriendo sin reportar. Si no se puede confirmar en un tiempo razonable, se informa como «sin
confirmar» y se sigue.
