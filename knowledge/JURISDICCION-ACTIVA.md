# Jurisdicción activa

**Jurisdicción activa por defecto: `cordoba`.**

Los agentes `legal-ph` y `contador` leen **solo** de `knowledge/<jurisdicción-activa>/`. Mientras la
jurisdicción activa sea `cordoba`, ambos agentes buscan sus fuentes en `knowledge/cordoba/` y en
ninguna otra carpeta.

## Cómo se estructura cada jurisdicción

```
knowledge/<provincia>/
├── nacional/        ← normativa nacional aplicable (igual para todas las provincias, pero se
│                       carga por jurisdicción para que el agente no tenga que buscar afuera)
├── provincial/       ← personas jurídicas, uso/fraccionamiento del suelo, régimen fiscal provincial
├── municipal/         ← ordenanzas locales, tasas (varía según la localidad dentro de la provincia)
└── jurisprudencia/    ← criterios de tribunales relevantes de esa jurisdicción
```

## Cómo cambiar la jurisdicción activa

1. Crear `knowledge/<nueva-provincia>/` con la misma estructura de 4 carpetas (ver
   `docs/agents/guia-carga-conocimiento.md` para qué cargar en cada una).
2. Cargar las fuentes oficiales vigentes en cada subcarpeta.
3. Editar este archivo: cambiar el valor de "Jurisdicción activa por defecto" a la nueva provincia.
4. Si el sistema pasa a operar **varias jurisdicciones a la vez** (multi-provincia), la jurisdicción
   activa deja de ser un valor único acá y pasa a ser un dato por barrio en el modelo de datos — eso es
   una decisión de producto de **Fase 6B**, no de este archivo. Hasta entonces, hay una sola
   jurisdicción activa para todo el sistema.

## Estado actual

- **Activa:** `cordoba`
- **Carpetas creadas:** `knowledge/cordoba/{nacional,provincial,municipal,jurisprudencia}/`, todas con
  placeholders — **ningún archivo de norma real está cargado todavía**. Ver
  `docs/agents/guia-carga-conocimiento.md` para la lista de qué cargar y de dónde sacarlo.
- Hasta que se cargue contenido real, `legal-ph` y `contador` van a responder **"no tengo esa fuente
  cargada"** ante casi cualquier consulta — es el comportamiento correcto (guardrail), no un error.
