// =====================================================================
// SR GESTORÍA · Función segura "sr-usuarios" (Supabase Edge Function)
// Desarrollo: JMM Gestiones & Tecnología · Jorge Matías Maldonado
//
// Crea y administra usuarios desde la Mesa Central SIN poner la clave
// maestra en las páginas: la clave sólo existe acá, del lado de Supabase.
// Antes de hacer cualquier cosa verifica que quien llama sea administradora.
//
// Acciones (campo "accion" del pedido):
//   crear_comercio   { email, password, nombre, titular, cuil, telefono?, cuentas?: [{nombre, detalle?}] }
//   agregar_usuario  { comercio_id, email, password, nombre }      (otro usuario para un comercio existente)
//   crear_admin      { email, password, nombre }
//   desactivar       { user_id }
//   reactivar        { user_id }
//   cambiar_clave    { user_id, password }
//   eliminar_usuario { user_id }                       (sólo si todavía no cargó movimientos)
//   eliminar_comercio { comercio_id, cuil }             (borra el comercio con todo lo suyo; el CUIL confirma)
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const resp = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const error = (status: number, mensaje: string) => resp(status, { ok: false, error: mensaje });

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const CLAVE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(URL_SB, CLAVE, { auth: { persistSession: false, autoRefreshToken: false } });

const emailOk = (e: unknown) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
const claveOk = (p: unknown) => typeof p === "string" && p.length >= 8;
const texto = (t: unknown, max = 120) => (typeof t === "string" ? t.trim().slice(0, max) : "");

// Traduce errores frecuentes a mensajes claros
function traducir(msg: string): string {
  const m = (msg || "").toLowerCase();
  if (m.includes("already") && (m.includes("registered") || m.includes("exists"))) return "Ya existe un usuario con ese mail.";
  if (m.includes("comercios_cuil_valido")) return "El CUIL no es válido. Revisá los números (formato XX-XXXXXXXX-X).";
  if (m.includes("comercios_cuil_key") || (m.includes("duplicate") && m.includes("cuil"))) return "Ya existe un comercio con ese CUIL.";
  if (m.includes("password")) return "La contraseña no es válida (mínimo 8 caracteres).";
  return msg || "Error desconocido";
}

async function crearUsuarioAuth(email: string, password: string, nombre: string) {
  const { data, error: e } = await sb.auth.admin.createUser({
    email: email.trim().toLowerCase(),
    password,
    email_confirm: true,
    user_metadata: { nombre },
  });
  if (e || !data?.user) throw new Error(traducir(e?.message ?? ""));
  return data.user;
}

async function completarPerfil(user_id: string, email: string, datos: Record<string, unknown>) {
  const { error: e } = await sb.from("perfiles")
    .upsert({ user_id, email: email.trim().toLowerCase(), activo: true, ...datos }, { onConflict: "user_id" });
  if (e) throw new Error(traducir(e.message));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return error(405, "Método no permitido");

  // 1) ¿Quién llama?
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return error(401, "Sesión no iniciada");
  const { data: quien, error: eQuien } = await sb.auth.getUser(jwt);
  if (eQuien || !quien?.user) return error(401, "Sesión vencida. Volvé a ingresar.");

  // 2) ¿Es administradora activa?
  const { data: perfil, error: ePerfil } = await sb.from("perfiles").select("rol, activo").eq("user_id", quien.user.id).maybeSingle();
  if (ePerfil) return error(500, "La función no pudo leer los perfiles: " + ePerfil.message + ". Corré en el SQL Editor los permisos para service_role (ver instructivo).");
  if (!perfil) return error(403, "Tu usuario no tiene perfil cargado. Corré de nuevo el SQL con tu mail en la línea <<<.");
  if (perfil.rol !== "admin" || !perfil.activo) return error(403, "Sólo la administración puede gestionar usuarios.");

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return error(400, "Pedido inválido"); }
  const accion = texto(b.accion, 30);

  try {
    switch (accion) {
      case "crear_comercio": {
        const email = texto(b.email, 200), nombre = texto(b.nombre), titular = texto(b.titular), cuil = texto(b.cuil, 13);
        if (!emailOk(email)) return error(400, "Mail inválido.");
        if (!claveOk(b.password)) return error(400, "La contraseña debe tener al menos 8 caracteres.");
        if (!nombre || !titular || !cuil) return error(400, "Completá nombre del comercio, titular y CUIL.");

        // a) comercio
        const { data: com, error: eCom } = await sb.from("comercios")
          .insert({ nombre, titular, cuil, telefono: texto(b.telefono, 40) || null }).select("id").single();
        if (eCom || !com) return error(400, traducir(eCom?.message ?? ""));

        // b) usuario (si falla, se deshace el comercio)
        let user;
        try { user = await crearUsuarioAuth(email, b.password as string, titular); }
        catch (e) { await sb.from("comercios").delete().eq("id", com.id); return error(400, (e as Error).message); }

        // c) perfil (si falla, se deshace todo)
        try { await completarPerfil(user.id, email, { rol: "comercio", comercio_id: com.id, nombre: titular }); }
        catch (e) {
          await sb.auth.admin.deleteUser(user.id);
          await sb.from("comercios").delete().eq("id", com.id);
          return error(400, (e as Error).message);
        }

        // d) cuentas iniciales (opcional)
        const cuentas = Array.isArray(b.cuentas) ? b.cuentas : [];
        const filas = cuentas
          .map((c: Record<string, unknown>, i: number) => ({ comercio_id: com.id, nombre: texto(c?.nombre, 60), detalle: texto(c?.detalle, 80) || null, orden: i }))
          .filter((c) => c.nombre);
        if (filas.length) await sb.from("cuentas").insert(filas);

        return resp(200, { ok: true, comercio_id: com.id, user_id: user.id });
      }

      case "agregar_usuario": {
        const email = texto(b.email, 200), nombre = texto(b.nombre), comercio_id = texto(b.comercio_id, 40);
        if (!emailOk(email)) return error(400, "Mail inválido.");
        if (!claveOk(b.password)) return error(400, "La contraseña debe tener al menos 8 caracteres.");
        const { data: com } = await sb.from("comercios").select("id").eq("id", comercio_id).maybeSingle();
        if (!com) return error(400, "Comercio inexistente.");
        const user = await crearUsuarioAuth(email, b.password as string, nombre);
        try { await completarPerfil(user.id, email, { rol: "comercio", comercio_id, nombre }); }
        catch (e) { await sb.auth.admin.deleteUser(user.id); throw e; }
        return resp(200, { ok: true, user_id: user.id });
      }

      case "crear_admin": {
        const email = texto(b.email, 200), nombre = texto(b.nombre);
        if (!emailOk(email)) return error(400, "Mail inválido.");
        if (!claveOk(b.password)) return error(400, "La contraseña debe tener al menos 8 caracteres.");
        const user = await crearUsuarioAuth(email, b.password as string, nombre);
        try { await completarPerfil(user.id, email, { rol: "admin", comercio_id: null, nombre }); }
        catch (e) { await sb.auth.admin.deleteUser(user.id); throw e; }
        return resp(200, { ok: true, user_id: user.id });
      }

      case "desactivar":
      case "reactivar": {
        const user_id = texto(b.user_id, 40);
        if (!user_id) return error(400, "Falta el usuario.");
        if (user_id === quien.user.id) return error(400, "No podés desactivarte a vos misma.");
        const activo = accion === "reactivar";
        const { error: eBan } = await sb.auth.admin.updateUserById(user_id, { ban_duration: activo ? "none" : "876000h" });
        if (eBan) return error(400, traducir(eBan.message));
        const { error: eP } = await sb.from("perfiles").update({ activo }).eq("user_id", user_id);
        if (eP) return error(400, traducir(eP.message));
        return resp(200, { ok: true });
      }

      case "cambiar_clave": {
        const user_id = texto(b.user_id, 40);
        if (!user_id) return error(400, "Falta el usuario.");
        if (!claveOk(b.password)) return error(400, "La contraseña debe tener al menos 8 caracteres.");
        const { error: eC } = await sb.auth.admin.updateUserById(user_id, { password: b.password as string });
        if (eC) return error(400, traducir(eC.message));
        return resp(200, { ok: true });
      }

      case "eliminar_usuario": {
        const user_id = texto(b.user_id, 40);
        if (!user_id) return error(400, "Falta el usuario.");
        if (user_id === quien.user.id) return error(400, "No podés eliminar tu propio usuario.");
        const { count, error: eC } = await sb.from("movimientos").select("uid", { count: "exact", head: true }).eq("creado_por", user_id);
        if (eC) return error(400, traducir(eC.message));
        if (count) return error(400, `Este usuario ya cargó ${count} movimiento${count > 1 ? "s" : ""}: no se puede eliminar. Desactivalo en su lugar.`);
        const { error: eD } = await sb.auth.admin.deleteUser(user_id);   // su perfil se borra solo
        if (eD) return error(400, traducir(eD.message));
        return resp(200, { ok: true });
      }

      case "eliminar_comercio": {
        const comercio_id = texto(b.comercio_id, 40), cuil = texto(b.cuil, 13);
        const { data: com } = await sb.from("comercios").select("id, cuil").eq("id", comercio_id).maybeSingle();
        if (!com) return error(400, "Comercio inexistente.");
        if (com.cuil !== cuil) return error(400, "El CUIL no coincide: no se eliminó nada.");
        const { data: us } = await sb.from("perfiles").select("user_id, rol").eq("comercio_id", comercio_id);
        if ((us ?? []).some((u) => u.user_id === quien.user.id)) return error(400, "No podés eliminar el comercio de tu propio usuario.");
        for (const tabla of ["avisos", "historial", "movimientos", "cuentas"]) {
          const { error: e1 } = await sb.from(tabla).delete().eq("comercio_id", comercio_id);
          if (e1) return error(400, `No se pudo borrar ${tabla}: ${traducir(e1.message)}`);
        }
        for (const u of us ?? []) {
          const { error: e2 } = await sb.auth.admin.deleteUser(u.user_id);
          if (e2) return error(400, "No se pudo borrar un usuario: " + traducir(e2.message));
        }
        await sb.from("perfiles").delete().eq("comercio_id", comercio_id);     // por si quedó alguno
        const { error: e3 } = await sb.from("comercios").delete().eq("id", comercio_id);
        if (e3) return error(400, "No se pudo borrar el comercio: " + traducir(e3.message));
        return resp(200, { ok: true });
      }

      default:
        return error(400, "Acción desconocida.");
    }
  } catch (e) {
    return error(400, traducir((e as Error).message));
  }
});
