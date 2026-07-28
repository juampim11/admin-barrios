/**
 * Lector mínimo del `docker-compose.yml` — lo justo para verificar **qué recibe cada contenedor**.
 *
 * Por qué no un parser de YAML: sumar una dependencia (y su cadena de supply-chain) para leer tres
 * claves de un archivo nuestro, de formato estable, es caro para lo que resuelve. Este lector es
 * tosco **a propósito**, en la línea de `docs/arquitectura/02` §5.3 ("una regla que se verifica en 40
 * milisegundos y falla el build vale más que un lint sofisticado que nadie configura").
 *
 * El riesgo obvio de un lector tosco es el **falso verde**: que deje de encontrar los servicios y
 * todo pase. Por eso el test que lo usa incluye un caso de control con una violación inyectada, y
 * exige que la lista de servicios no venga vacía.
 */

export type ServicioCompose = {
  readonly nombre: string;
  /** Texto crudo del bloque del servicio (sin la línea del nombre). */
  readonly bloque: string;
  /** Claves declaradas bajo `environment:` (soporta el estilo mapa y el estilo lista `- CLAVE=valor`). */
  readonly variables: readonly string[];
  /** ¿Declara `env_file:`? Es el agujero grande: arrastra el `.env` entero adentro del contenedor. */
  readonly tieneEnvFile: boolean;
  /** ¿Se construye desde un `Dockerfile` nuestro? Entonces corre código nuestro. */
  readonly seConstruye: boolean;
  /** Entradas de `ports:`, tal cual están escritas. */
  readonly puertos: readonly string[];
};

const RE_SERVICIO = /^ {2}([A-Za-z0-9._-]+):\s*$/;
const RE_CLAVE_SERVICIO = /^ {4}([A-Za-z0-9._-]+):/;
const RE_VARIABLE_MAPA = /^ {6}([A-Za-z_][A-Za-z0-9_]*):/;
const RE_VARIABLE_LISTA = /^ {6}- +"?([A-Za-z_][A-Za-z0-9_]*)=/;
const RE_ITEM_LISTA = /^ {6}- +"?([^"\n]+?)"?\s*$/;

/** Quita comentarios de línea completa; los inline no se tocan (pueden ser parte de un valor). */
function esComentario(linea: string): boolean {
  return /^\s*#/.test(linea);
}

export function leerServicios(texto: string): ServicioCompose[] {
  const lineas = texto.split(/\r?\n/);
  const inicioServicios = lineas.findIndex((l) => /^services:\s*$/.test(l));
  if (inicioServicios === -1) return [];

  const servicios: ServicioCompose[] = [];
  let actual: { nombre: string; lineas: string[] } | null = null;

  const cerrar = () => {
    if (!actual) return;
    servicios.push(construir(actual.nombre, actual.lineas));
    actual = null;
  };

  for (let i = inicioServicios + 1; i < lineas.length; i++) {
    const linea = lineas[i] ?? "";
    // Una línea sin indentación y con contenido cierra la sección `services:` (ej. `volumes:`).
    if (linea.trim() !== "" && !esComentario(linea) && !linea.startsWith(" ")) {
      cerrar();
      break;
    }
    const encabezado = RE_SERVICIO.exec(linea);
    if (encabezado?.[1]) {
      cerrar();
      actual = { nombre: encabezado[1], lineas: [] };
      continue;
    }
    if (actual) actual.lineas.push(linea);
  }
  cerrar();

  return servicios;
}

function construir(nombre: string, lineas: readonly string[]): ServicioCompose {
  const variables: string[] = [];
  const puertos: string[] = [];
  let tieneEnvFile = false;
  let seConstruye = false;
  let seccion: "environment" | "ports" | "otra" = "otra";

  for (const linea of lineas) {
    if (esComentario(linea) || linea.trim() === "") continue;

    const clave = RE_CLAVE_SERVICIO.exec(linea)?.[1];
    if (clave) {
      if (clave === "env_file") tieneEnvFile = true;
      if (clave === "build") seConstruye = true;
      seccion = clave === "environment" ? "environment" : clave === "ports" ? "ports" : "otra";
      continue;
    }

    if (seccion === "environment") {
      const variable = RE_VARIABLE_MAPA.exec(linea)?.[1] ?? RE_VARIABLE_LISTA.exec(linea)?.[1];
      if (variable) variables.push(variable);
    } else if (seccion === "ports") {
      const puerto = RE_ITEM_LISTA.exec(linea)?.[1];
      if (puerto) puertos.push(puerto);
    }
  }

  return { nombre, bloque: lineas.join("\n"), variables, tieneEnvFile, seConstruye, puertos };
}

/**
 * Texto del bloque **sin las interpolaciones de compose** (`${VAR:-default}`).
 *
 * Distinción que importa: `${JOB_DB_PASSWORD}` adentro de una URL es una sustitución que hace compose
 * al leer el archivo — el contenedor recibe el valor ya resuelto, **no** la variable. Buscar el
 * nombre a secas daría un falso positivo en el servicio del worker, que legítimamente arma su URL así.
 */
export function bloqueSinInterpolaciones(servicio: ServicioCompose): string {
  return servicio.bloque.replace(/\$\{[^}]*\}/g, "");
}

/** ¿El puerto queda publicado en todas las interfaces de red de la máquina? */
export function publicaEnTodasLasInterfaces(puerto: string): boolean {
  // "5432:5432" o "0.0.0.0:5432:5432" → sí. "127.0.0.1:5432:5432" → no.
  const partes = puerto.split(":");
  if (partes.length <= 2) return true;
  const direccion = partes[0] ?? "";
  return direccion === "0.0.0.0" || direccion === "::" || direccion === "*";
}
