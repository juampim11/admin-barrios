# 01 · Entornos (producción y testing) — guía neutral de infraestructura

> **Plantilla.** Reemplazá los marcadores `<ASI>` por los valores de tu proyecto. Esta guía es
> **neutral respecto del proveedor**: usa **`<PROVEEDOR_HOSTING>`** (ej. Vercel, Netlify, AWS
> Amplify, Cloud Run) y **`<PROVEEDOR_BD>`** (ej. Supabase, Neon, PlanetScale, AWS RDS) como piezas
> **intercambiables**. Los principios valen igual con cualquiera; los ejemplos concretos van entre
> paréntesis.

---

## 0. Por qué dos entornos (el problema que evita)

Con **un solo mundo** (una base y un hosting), desarrollar y probar en tu máquina se conecta a la
**base de producción**: cada prueba consume recursos reales y puede corromper datos reales. La
solución de base: **dos entornos separados**.

```
   Rama de producción  ──►  <PROVEEDOR_HOSTING> · Producción  ──►  <PROVEEDOR_BD> PROD   (datos reales)
   Ramas de trabajo    ──►  <PROVEEDOR_HOSTING> · Preview      ──►  <PROVEEDOR_BD> TESTING (datos de prueba)
   y pruebas locales
```

**Principio 1 — Aislamiento total:** producción nunca recibe tráfico de desarrollo. Testing usa
**sus propias credenciales**, jamás las de producción.

---

## 1. Mapa de entornos

| Origen | Hosting despliega en | Base de datos | Cuándo |
|---|---|---|---|
| Rama **`<RAMA_PRODUCCION>`** (por defecto `main`) | **Production** | **`<PROVEEDOR_BD>` PROD** (`<REF_PROYECTO_PROD>`) | en cada push/merge |
| **Cualquier otra rama** de trabajo | **Preview** (URL por rama) | **`<PROVEEDOR_BD>` TESTING** (`<REF_PROYECTO_TESTING>`) | en cada push a esa rama |
| Tu máquina (`.env.local`) | local | **`<PROVEEDOR_BD>` TESTING** | siempre |

> **Opcional — URL de staging estable:** si querés *una* dirección fija para mostrar/probar (en vez
> de una URL distinta por rama), usá una rama fija `staging` o `develop` apuntada al entorno de
> testing. No es obligatorio; es comodidad.

---

## 2. Variables de entorno (el puente entre deploy y base)

**Principio 2 — Cada variable existe dos veces:** una en *Production* (valor de prod) y otra en
*Preview/Development* (valor de testing). Al **agregar una variable nueva**, cargala en **los dos**
scopes del hosting **y** en tu `.env.local`. Si falta en alguno, ese entorno rompe.

| Variable (ejemplo) | Producción | Testing / Preview | `.env.local` | ¿Secreta? |
|---|---|---|---|---|
| `<VAR_URL_BD>` | URL de PROD (`<URL_BASE_DATOS_PROD>`) | URL de TESTING (`<URL_BASE_DATOS_TESTING>`) | URL de TESTING | No (pública) |
| `<VAR_CLAVE_PUBLICA_BD>` | clave pública PROD | clave pública TESTING | clave pública TESTING | No |
| `<VAR_CLAVE_SECRETA_BD>` | clave secreta PROD | clave secreta TESTING | clave secreta TESTING | 🔴 **Sí** |
| `<VAR_SECRET_CRON>` | valor A | valor B **distinto** | valor B | 🔴 Sí |
| `<VAR_INTEGRACIONES_*>` (email, pagos, OCR…) | credenciales reales | de prueba / modo off | de prueba / off | 🔴 Sí |
| `<VAR_CONFIG_NO_SECRETA>` (timezone, flags) | igual en ambos | igual | igual | No |

**Reglas de secretos:**
1. Ningún secreto en el repo ni por chat/mail: se cargan directo en el panel del hosting y en
   `.env.local` (que está gitigneado).
2. La **clave secreta / de servicio** de la base **nunca** con prefijo público ni en el navegador.
   Si se filtra, se rota de inmediato.
3. Usá un **secreto de cron distinto** por entorno, para que un disparo de un entorno no sirva contra
   el otro.
4. Las variables "públicas" que se **hornean en el build** (ej. `NEXT_PUBLIC_*` en Next, `VITE_*` en
   Vite) quedan fijas al momento del build → si cambian, hay que **rebuildear**.

---

## 3. Preparar el entorno de testing (una vez)

**Principio 3 — Testing es un clon estructural de prod, con datos sintéticos:**

1. **Crear** el proyecto/base de testing en `<PROVEEDOR_BD>` (misma región que prod si se puede).
   Generar una **contraseña distinta** a la de prod.
2. **Aplicar el esquema:** correr todas las migraciones sobre testing (`<COMANDO_MIGRACIONES>`).
3. **Cargar catálogo base** (datos de configuración, no personales).
4. **Cargar datos de prueba sintéticos** — **nunca** el padrón real con datos personales (ver §5).
5. **Cargar las variables** de testing en el hosting (scope Preview) y en `.env.local`.

> **Límites del plan gratis (verificar los vigentes del proveedor elegido):** muchos free tiers
> permiten **2 proyectos activos** por organización (prod + testing llegan justo), y **pausan** un
> proyecto sin uso por un tiempo. Presupuestar ambos entornos contra el mismo plan.

---

## 4. Aplicar cambios de base (migraciones) — el paso que no es automático

**Principio 4 — El hosting despliega CÓDIGO, no ESQUEMA.** Código y base se coordinan a mano:

> **Regla de oro:** para una migración **aditiva y compatible hacia atrás** (agregar tabla/columna/
> índice/vista sin romper lo viejo), aplicala a **prod ANTES** de mergear el código. El orden inverso
> deja una ventana en la que prod corre contra un esquema que todavía no existe → error.

Flujo genérico (adaptá `<COMANDO_MIGRACIONES>` a tu herramienta):

```
# 1) VERIFICAR a qué entorno apunta la CLI (el error más caro es aplicar al equivocado)
<COMANDO_VER_ENTORNO_ACTIVO>

# 2) Aplicar a TESTING (durante el desarrollo)
<COMANDO_VINCULAR_TESTING> && <COMANDO_MIGRACIONES>

# 3) Aplicar a PROD (recién en el pasaje a producción, con aprobación)
<COMANDO_VINCULAR_PROD> && <COMANDO_MIGRACIONES>

# 4) Regenerar tipos/artefactos si cambió el esquema
<COMANDO_REGENERAR_TIPOS>
```

**Reglas duras:** nunca editar una migración ya aplicada; crear una nueva con prefijo incremental;
regenerar tipos después. **Cambios destructivos** (renombrar/eliminar columna en uso): patrón
**expand/contract** en dos pasos, nunca en una sola migración.

**Caveat de testing compartido:** si hay **una sola** base de testing para todas las ramas de
preview, dos ramas con migraciones distintas se pisan. Con equipo chico, alcanza con tener **una
feature con migración a la vez** en testing.

---

## 5. Qué NO hacer (seguridad — leer antes de tocar)

1. **Nunca apuntar testing (ni `.env.local`) a las credenciales de PRODUCCIÓN.**
2. **La clave de servicio jamás en el navegador** ni con prefijo público. Solo variable server.
3. **No cargar datos personales reales en testing.** Testing usa datos **sintéticos**. La PII real
   solo vive en producción.
4. **Antes de cada migración, confirmar a qué entorno apunta la CLI.** Aplicar al equivocado es el
   error más caro.
5. **Secretos distintos por entorno** (cron, tokens de integración).
6. **Ningún secreto por chat, mail o captura.**

---

## 6. Rollback (principio de seguridad)

- **Código:** revertir el merge en la rama de producción (el hosting redepliega el estado anterior) o
  promover un deploy previo desde el panel.
- **Base:** **nunca** se "desaplica" una migración editándola. Se crea una **migración nueva** que
  revierte el efecto (forward-fix). Por eso las migraciones aditivas/compatibles son preferibles.
- **Datos:** si el plan **no** tiene backups automáticos, **presupuestar backups manuales** antes de
  cada release — otra razón para que prod solo reciba cambios ya probados en testing.

---

_Plantilla del template `<NOMBRE_PROYECTO>`. Ver `02-sdlc-git-flow.md` (cómo se trabaja cada cambio) y
`03-reglas-desarrollo-optimizado.md` (presupuesto de recursos y buenas prácticas)._
