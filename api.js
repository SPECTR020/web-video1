import crypto from "crypto";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Método no permitido" }) };
  }

  // Conexión directa al almacenamiento interno de Netlify (Blobs)
  let blobToken = process.env.NETLIFY_BLOBS_TOKEN;
  let blobUrl = process.env.NETLIFY_BLOBS_URL;

  if (context.clientContext && context.clientContext.custom && context.clientContext.custom.netlify) {
    const raw = JSON.parse(Buffer.from(context.clientContext.custom.netlify, "base64").toString("utf8"));
    blobToken = raw.blobs.token;
    blobUrl = raw.blobs.url;
  }

  const siteID = process.env.SITE_ID;
  const baseUrl = `${blobUrl}/${siteID}/video-store`;
  const headers = { Authorization: `Bearer ${blobToken}` };

  // Funciones auxiliares para leer, guardar y borrar datos en Netlify
  async function getData(key) {
    const res = await fetch(`${baseUrl}/${encodeURIComponent(key)}`, { headers });
    if (!res.ok) return null;
    return await res.json();
  }

  async function setData(key, value) {
    await fetch(`${baseUrl}/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(value)
    });
  }

  async function deleteData(key) {
    await fetch(`${baseUrl}/${encodeURIComponent(key)}`, { method: "DELETE", headers });
  }

  async function listUsers() {
    const res = await fetch(`${baseUrl}?prefix=user:`, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    const users = [];
    for (const item of (data.blobs || [])) {
      const u = await getData(item.key);
      if (u) users.push({ username: item.key.replace("user:", ""), ...u });
    }
    return users;
  }

  const body = JSON.parse(event.body || "{}");
  const { action } = body;

  // Contraseña maestra para entrar a admin.html (puedes cambiarla aquí)
  const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin1234";

  // --- 1. ACCIONES DE CLIENTES ---
  if (action === "login") {
    const { username, password } = body;
    const user = await getData(`user:${username}`);

    if (!user || user.password !== password) {
      return { statusCode: 401, body: JSON.stringify({ error: "Usuario o contraseña incorrectos." }) };
    }

    const now = Date.now();
    if (now > user.expiresAt) {
      await deleteData(`user:${username}`);
      return { statusCode: 403, body: JSON.stringify({ error: "Tu acceso ha caducado." }) };
    }

    if (user.activeToken && now - user.lastPing < 15000) {
      return { statusCode: 409, body: JSON.stringify({ error: "Esta cuenta ya está abierta en otro dispositivo." }) };
    }

    const config = await getData("config");
    if (!config || !config.videoUrl) {
      return { statusCode: 404, body: JSON.stringify({ error: "Aún no hay ningún vídeo configurado." }) };
    }

    const token = crypto.randomUUID();
    user.activeToken = token;
    user.lastPing = now;
    await setData(`user:${username}`, user);

    return {
      statusCode: 200,
      body: JSON.stringify({ token, expiresAt: user.expiresAt, videoUrl: config.videoUrl })
    };
  }

  if (action === "heartbeat") {
    const { username, token } = body;
    const user = await getData(`user:${username}`);

    if (!user || Date.now() > user.expiresAt) {
      if (user) await deleteData(`user:${username}`);
      return { statusCode: 403, body: JSON.stringify({ valid: false, reason: "Tu tiempo de acceso ha caducado." }) };
    }

    if (user.activeToken !== token) {
      return { statusCode: 409, body: JSON.stringify({ valid: false, reason: "Se ha iniciado sesión en otro dispositivo." }) };
    }

    user.lastPing = Date.now();
    await setData(`user:${username}`, user);
    return { statusCode: 200, body: JSON.stringify({ valid: true }) };
  }

  // --- 2. ACCIONES DE ADMINISTRADOR ---
  if (body.adminPass !== ADMIN_PASS) {
    return { statusCode: 401, body: JSON.stringify({ error: "Contraseña de administrador incorrecta." }) };
  }

  if (action === "admin_get") {
    const config = (await getData("config")) || { videoUrl: "" };
    const users = await listUsers();
    return { statusCode: 200, body: JSON.stringify({ videoUrl: config.videoUrl, users }) };
  }

  if (action === "admin_set_video") {
    await setData("config", { videoUrl: body.videoUrl });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (action === "admin_create_user") {
    const { username, password, minutes } = body;
    await setData(`user:${username}`, {
      password,
      expiresAt: Date.now() + minutes * 60 * 1000,
      activeToken: null,
      lastPing: 0
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (action === "admin_delete_user") {
    await deleteData(`user:${body.username}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: "Acción no válida" }) };
};