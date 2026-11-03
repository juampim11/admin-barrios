# Tiempos del gate y topes de volumen

> Fuente de los topes de `tests/volumen/topes.ts` (BL-016, ADR-0008 §6). Se actualiza cada vez que se
> mide de nuevo: **un tope se cambia mirando esta tabla**, no a ojo.

## Cómo se mide

- El paso solo: `pnpm test:volumen` (proyecto `volumen`: un proceso, un archivo por vez), con la base
  levantada (`pnpm db:up`, `pnpm db:migrate && pnpm db:setup`) y `CHROME_PATH` apuntando a Chrome.
- Cada prueba imprime una línea `[volumen] <prueba> ms=… [picoRssMb=…]`. Se corren **3 veces** y el
  tope es **2 a 3 veces lo peor medido**, siempre por debajo del límite que importa en la app.
- Si un tope se pasa, primero se mira **el plan de la consulta o el armado del lote**; recién después
  se discute el número.

## Medición del 2026-11-02 (máquina local de desarrollo, Windows, Postgres 16 en Docker)

| Prueba (700 UF)                    | Corrida 1 | Corrida 2 | Corrida 3 | Tope     |
|------------------------------------|-----------|-----------|-----------|----------|
| Liquidación (generar el borrador)  | 3.476 ms  | 9.769 ms  | 4.628 ms  | 25.000 ms |
| Emisión del período                | 137 ms    | 661 ms    | 147 ms    | 2.000 ms |
| Pantalla del período (4 lecturas)  | 71 ms     | 376 ms    | 316 ms    | 1.000 ms |
| 700 boletas en PDF (lotes de 50)   | 139,8 s   | 108,1 s   | 136,2 s   | 360 s    |
| Pico de memoria del lote de PDF    | 375 MB    | 364 MB    | 374 MB    | 900 MB   |

- La corrida 2 coincidió con otras tareas en la máquina: es la más lenta en las tres consultas.
- Las boletas pesan ~121 KB cada una. El pico de memoria es del proceso de Node; el tope queda por
  debajo del presupuesto de 1 GB del contenedor del worker (ADR-0001 §3.2).
- **Antes del arreglo del lote**, generar el borrador de 700 UF tardaba **29,9 s** (inserción fila por
  fila). Ver ADR-0008 §6.
