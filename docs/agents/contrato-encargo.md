# Contrato del encargo y del reporte

Formato de todo mensaje de la coordinación al implementador y de vuelta. El implementador **rechaza** un encargo al que le falte una sección obligatoria, antes de tocar el repo, y lo dice en una línea.

## Encargo (coordinación → implementador)

```
ENCARGO <código> — <título corto>. Plan aprobado por adelantado.
TIPO: código | configuración (si es configuración: requiere confirmación del titular en la ventana del implementador)
TAMAÑO: archivos≈<n>, nuevos≈<n>, pasos≈<n> → 1 tramo | tramo X de N
MODELOS: sesión <Sonnet|Opus> · búsqueda Haiku · revisor <Sonnet|Opus> · personas: <ninguna | cuáles>

CONTEXTO (1 o 2 líneas)
ALCANCE (pasos numerados y concretos; sin decisiones de diseño abiertas)
FUERA DE ALCANCE
COMPORTAMIENTO ESPERADO
VALIDACIÓN (tests, typecheck, CI, prueba manual si hay pantalla)
REPORTE (qué evidencia)
MOTIVOS PARA FRENAR (lista cerrada; fuera de estos, el implementador sigue sola)
```

Motivos de freno que van siempre, además de los propios del encargo:
1. tocar el motor de plata o cambiar una cifra esperada de un test de importes;
2. una migración con DML sobre datos existentes;
3. necesitar abrir `.env*`, `privado/` o datos reales;
4. CI rojo dos veces seguidas por una causa ajena al encargo;
5. una decisión de producto que no esté en el encargo ni en los docs del repo.

## Reporte (implementador → coordinación)

```
REPORTE <código> — <hecho | parcial | frenado>
Rama · SHA del head · PR #n · CI (id del run, estado)
git diff --stat main...HEAD (resumen)
Tests: nuevos <n>, resultado
Revisión: veredicto del code-reviewer y hallazgos mayores corregidos
Desvíos o decisiones tomadas sin el titular (también en HANDOFF)
Si es parcial: hecho / pendiente / validación sin correr
```

Sin relato. El detalle largo va al HANDOFF del repo, no al mensaje.

## Corrección (coordinación → implementador)

Solo los hallazgos bloqueantes o mayores, con archivo, problema y arreglo esperado; el mismo alcance del encargo original; vuelve a revisar solo el diff de la corrección. Máximo 2 vueltas; a la tercera, freno y aviso al titular.

## Tamaño y tramos

Si los pasos estimados superan unos 25, el encargo se parte en tramos encadenados (un PR por tramo o commits por tramo, según el caso). Si el implementador se corta a mitad, el encargo siguiente lista lo hecho (no rehacer) y solo lo pendiente.
