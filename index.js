const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Raw } = require("telegram/events");
const { UpdateConnectionState } = require("telegram/network");
const input = require("input");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
require("dotenv").config();

const SESSION_FILE = path.join(__dirname, "session.txt");

// Aborta una promesa que tarda demasiado para que un getMessages "colgado"
// (conexion rota que nunca lanza ni resuelve) no bloquee el loop de polling.
function withTimeout(promise, ms, label = "operacion") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT_LOCAL: ${label} supero ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function loadSession() {
  if (fs.existsSync(SESSION_FILE)) return fs.readFileSync(SESSION_FILE, "utf-8").trim();
  return process.env.SESSION || "";
}

function saveSession(str) {
  fs.writeFileSync(SESSION_FILE, str, "utf-8");
}

// Envía el mensaje usando el Bot API para que Telegram dispare notificación push
async function enviarViaBot(botToken, chatId, msg, client, prefixText = "") {
  if (msg.className === "MessageService") return false;

  const rawText = msg.message || "";
  const text = prefixText ? (rawText ? `${prefixText}\n${rawText}` : prefixText) : rawText;
  const apiBase = `https://api.telegram.org/bot${botToken}`;

  if (msg.media) {
    let endpoint, fileField, mimeType;
    const mediaClass = msg.media.className;

    if (mediaClass === "MessageMediaPhoto") {
      endpoint = "sendPhoto";
      fileField = "photo";
      mimeType = "image/jpeg";
    } else if (mediaClass === "MessageMediaDocument") {
      const doc = msg.media.document;
      const attrs = doc.attributes || [];
      const hasVideo = attrs.some(a => a.className === "DocumentAttributeVideo");
      const audioAttr = attrs.find(a => a.className === "DocumentAttributeAudio");
      const mime = doc.mimeType || "";

      if (hasVideo || mime.startsWith("video/")) {
        endpoint = "sendVideo";
        fileField = "video";
        mimeType = mime || "video/mp4";
      } else if (audioAttr && audioAttr.voice) {
        endpoint = "sendVoice";
        fileField = "voice";
        mimeType = mime || "audio/ogg";
      } else if (audioAttr || mime.startsWith("audio/")) {
        endpoint = "sendAudio";
        fileField = "audio";
        mimeType = mime || "audio/mpeg";
      } else {
        endpoint = "sendDocument";
        fileField = "document";
        mimeType = mime || "application/octet-stream";
      }

      // Saltar archivos mayores a 50 MB para no agotar la RAM
      const MAX_FILE_BYTES = 50 * 1024 * 1024;
      if (doc.size && doc.size > MAX_FILE_BYTES) {
        const aviso = text
          ? `${text}

⚠️ (archivo omitido: ${(doc.size / 1024 / 1024).toFixed(1)} MB supera el límite de 50 MB)`
          : `⚠️ Archivo omitido: ${(doc.size / 1024 / 1024).toFixed(1)} MB supera el límite de 50 MB`;
        await axios.post(`${apiBase}/sendMessage`, { chat_id: String(chatId), text: aviso });
        return true;
      }
    } else {
      // Tipo de media no soportado (geo, contacto, etc.) — enviar solo texto si hay
      if (text) {
        await axios.post(`${apiBase}/sendMessage`, { chat_id: chatId, text });
      }
      return true;
    }

    const fileBytes = await client.downloadMedia(msg.media, {});
    if (!fileBytes || fileBytes.length === 0) return false;

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append(fileField, fileBytes, { filename: fileField, contentType: mimeType });
    if (text) form.append("caption", text);

    await axios.post(`${apiBase}/${endpoint}`, form, { headers: form.getHeaders() });
  } else if (text) {
    await axios.post(`${apiBase}/sendMessage`, { chat_id: String(chatId), text });
  } else {
    return false;
  }

  return true;
}

// Acepta username (con o sin @) o ID numérico como string
function resolveId(value) {
  if (/^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  const clean = value.trim().replace(/^@/, "");
  return `@${clean}`;
}

// Obtiene el nombre visible de un remitente
function senderName(msg) {
  const s = msg.sender;
  if (!s) return "desconocido";
  if (s.username) return `@${s.username}`;
  if (s.firstName) return s.firstName + (s.lastName ? ` ${s.lastName}` : "");
  return "desconocido";
}

// Devuelve el ID del mensaje respondido solo para replies genuinos.
// En topics/foros, Telegram puede setear replyToMsgId = replyToTopId como anclaje del hilo.
function getRealReplyMsgId(msg) {
  const replyToMsgId = msg.replyTo?.replyToMsgId ?? null;
  if (!replyToMsgId) return null;

  const replyToTopId = msg.replyTo?.replyToTopId ?? null;
  if (replyToTopId && replyToMsgId === replyToTopId) return null;

  return replyToMsgId;
}

// Sigue la cadena de replies hacia atrás y devuelve los mensajes en orden cronológico
async function getMessageChain(client, groupEntity, startMsgId, maxDepth = 20) {
  const chain = [];
  let currentId = startMsgId;
  let depth = 0;

  while (currentId && depth < maxDepth) {
    const [msg] = await client.getMessages(groupEntity, { ids: [currentId] });
    if (!msg) break;
    chain.unshift(msg);
    currentId = msg.replyTo?.replyToMsgId ?? null;
    depth++;
  }

  return chain;
}

async function main() {
  const API_ID = parseInt(process.env.API_ID, 10);
  const API_HASH = process.env.API_HASH;

  if (!API_ID || !API_HASH) {
    console.error("\nError: API_ID y API_HASH son requeridos.");
    console.error("Obtenerlos en: https://my.telegram.org");
    console.error("Luego completar el archivo .env (copiar de .env.example)\n");
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(loadSession()), 
    API_ID, 
    API_HASH, 
    { 
        connectionRetries: 5,        // Menos intentos para evitar saturar la VM
        requestRetries: 3,           // Reducido para evitar peticiones duplicadas colgadas
        retryDelay: 5000,            // 5 segundos entre intentos (da respiro a la red)
        autoReconnect: true, 
        sequentialUpdates: true,
        useWss: true,                // 🔥 CLAVE: Fuerza WebSockets Seguros, ideal para la nube
        timeout: 10000,              // Evita que las peticiones se queden esperando para siempre
    }
);

  let reconnecting = false;
  let seenConnectedState = false;
  // Marca de tiempo de la ultima actividad exitosa (poll o reconexion).
  // El watchdog reinicia el proceso si pasa demasiado tiempo sin actividad.
  let lastSuccessfulActivity = Date.now();

  client.onError = async (err) => {
    if (!err) return;

    if (err.message === "TIMEOUT") {
      console.log("[conexion] Timeout detectado; la libreria intentara reconectar automaticamente.");
      return;
    }

    console.error("[client.onError]", err.message);
  };

  client.addEventHandler(
    (update) => {
      if (!(update instanceof UpdateConnectionState)) return;

      if (update.state === UpdateConnectionState.connected) {
        if (reconnecting) {
          console.log("[conexion] Reconectado.");
        } else if (!seenConnectedState) {
          console.log("[conexion] Conectado.");
        }

        reconnecting = false;
        seenConnectedState = true;
        lastSuccessfulActivity = Date.now();
        return;
      }

      if (update.state === UpdateConnectionState.disconnected) {
        if (!reconnecting) {
          console.log("[conexion] Conexion perdida. Esperando reconexion automatica...");
        }
        reconnecting = true;
        return;
      }

      if (update.state === UpdateConnectionState.broken) {
        console.log("[conexion] Conexion en estado roto (broken). Reiniciando proceso para que PM2 lo levante limpio...");
        reconnecting = true;
        setTimeout(() => process.exit(1), 3000);
      }
    },
    new Raw({ types: [UpdateConnectionState] })
  );

  await client.start({
    phoneNumber: () => input.text("Número de teléfono (ej: +5491112345678): "),
    password: () => input.text("Contraseña 2FA (Enter si no usás): "),
    phoneCode: () => input.text("Código de verificación de Telegram: "),
    onError: (err) => console.error("Error de autenticación:", err.message),
  });

  const currentSession = client.session.save();
  saveSession(currentSession);

  // Modo --list: mostrar todos los chats con sus IDs y salir
  if (process.argv.includes("--list")) {
    console.log("\nGrupos y chats activos:\n");
    const dialogs = await client.getDialogs({ limit: 200 });
    for (const d of dialogs) {
      const id = String(d.id).padStart(22);
      const title = d.title || "(sin nombre)";
      console.log(`  ${id}  →  ${title}`);
    }
    console.log("\nUsá el ID o el username en SOURCE_GROUP del archivo .env");
    await client.disconnect();
    return;
  }

  const { SOURCE_GROUP, SOURCE_USER, BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

  if (!SOURCE_GROUP || !SOURCE_USER || !BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("\nError: SOURCE_GROUP, SOURCE_USER, BOT_TOKEN y TELEGRAM_CHAT_ID son requeridos en .env\n");
    process.exit(1);
  }

  let groupEntity, userEntity;

  try {
    groupEntity = await client.getEntity(resolveId(SOURCE_GROUP));
  } catch (e) {
    console.error(`No se pudo resolver SOURCE_GROUP="${SOURCE_GROUP}": ${e.message}`);
    process.exit(1);
  }

  try {
    userEntity = await client.getEntity(resolveId(SOURCE_USER));
  } catch (e) {
    console.error(`No se pudo resolver SOURCE_USER="${SOURCE_USER}": ${e.message}`);
    process.exit(1);
  }

  const targetId = userEntity.id.toString();
  const groupName = groupEntity.title || groupEntity.username;

  console.log(`\nEscuchando en:     "${groupName}"`);
  console.log(`Filtrando usuario:  @${userEntity.username} (ID: ${targetId})`);
  console.log(`Reenviando a:       chat ID ${TELEGRAM_CHAT_ID} via bot\n`);

  // Inicializa el estado de updates del servidor
  await client.getDialogs({ limit: 10 });

  console.log("Activo. Presioná Ctrl+C para detener.\n");

  // Obtener el ID del último mensaje para no reenviar mensajes viejos
  const initialMessages = await client.getMessages(groupEntity, { limit: 1 });
  let lastSeenId = initialMessages.length > 0 ? initialMessages[0].id : 0;
  console.log(`Último mensaje conocido del grupo: ID ${lastSeenId}\n`);

  const POLL_INTERVAL_MS = 5000; // consultar cada 5 segundos
  const GET_MESSAGES_TIMEOUT_MS = 20000; // abortar getMessages si no responde en 20s
  const STALL_LIMIT_MS = 90000; // sin actividad exitosa por 90s → reiniciar proceso
  let isPolling = false; // evita polls superpuestos
  let restarting = false;

  // Watchdog independiente del loop: si el bot queda "colgado" sin reconectar
  // (getMessages que lanza error eterno o que nunca resuelve), reinicia el
  // proceso para que PM2 lo levante limpio. Esta es la red de seguridad real.
  let timer;
  const watchdog = setInterval(() => {
    const stalledMs = Date.now() - lastSuccessfulActivity;
    if (stalledMs >= STALL_LIMIT_MS && !restarting) {
      restarting = true;
      console.log(`[watchdog] Sin actividad exitosa por ${Math.round(stalledMs / 1000)}s. Reiniciando proceso para que PM2 lo levante limpio...`);
      clearInterval(timer);
      clearInterval(watchdog);
      setTimeout(() => process.exit(1), 1000);
    }
  }, 15000);

  timer = setInterval(async () => {
    if (isPolling || restarting) return;
    isPolling = true;
    try {
      const messages = await withTimeout(
        client.getMessages(groupEntity, {
          limit: 20,
          minId: lastSeenId,
        }),
        GET_MESSAGES_TIMEOUT_MS,
        "getMessages"
      );
      // El poll respondio: la conexion esta viva.
      lastSuccessfulActivity = Date.now();

      // getMessages devuelve del más reciente al más viejo; procesar en orden cronológico
      const ordered = messages.slice().reverse();

      for (const msg of ordered) {
        if (msg.id <= lastSeenId) continue;
        lastSeenId = msg.id;

        const senderId = msg.senderId ? msg.senderId.toString() : null;
        if (senderId !== targetId) continue;

        try {
          const replyToMsgId = getRealReplyMsgId(msg);

          if (replyToMsgId) {
            const chain = await getMessageChain(client, groupEntity, replyToMsgId);
            const contextChain = chain;
            if (contextChain.length === 1) {
              const nombre = senderName(contextChain[0]);
              await enviarViaBot(BOT_TOKEN, TELEGRAM_CHAT_ID, contextChain[0], client, `📩 Mensaje original (${nombre}):`);
            } else if (contextChain.length > 1) {
              await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: String(TELEGRAM_CHAT_ID),
                text: "🧵 Hilo de conversación:",
              });
              for (let i = 0; i < contextChain.length; i++) {
                const nombre = senderName(contextChain[i]);
                await enviarViaBot(BOT_TOKEN, TELEGRAM_CHAT_ID, contextChain[i], client, `📩 [${i + 1}/${contextChain.length}] ${nombre}:`);
              }
            }
          }

          const prefixRespuesta = replyToMsgId ? "↩️ Respuesta:" : "";
          const enviado = await enviarViaBot(BOT_TOKEN, TELEGRAM_CHAT_ID, msg, client, prefixRespuesta);
          // Procesar un mensaje (incluso una descarga larga de media) cuenta
          // como actividad para que el watchdog no reinicie en medio del trabajo.
          lastSuccessfulActivity = Date.now();
          if (enviado) {
            const timestamp = new Date().toLocaleString("es-AR");
            console.log(`[${timestamp}] Mensaje enviado (msg ID: ${msg.id})${replyToMsgId ? " [con contexto de respuesta]" : ""}`);
          } else if (msg.replyTo?.replyToMsgId && !replyToMsgId) {
            const timestamp = new Date().toLocaleString("es-AR");
            console.log(`[${timestamp}] Mensaje en topic sin reply real (msg ID: ${msg.id})`);
          }
        } catch (err) {
          console.error(`Error al enviar mensaje ID ${msg.id}:`, err.message);
        }
      }
    } catch (err) {
      const msgErr = err.message || "";
      if (msgErr === "TIMEOUT" || msgErr === "Not connected" || msgErr.startsWith("TIMEOUT_LOCAL")) {
        // No actualizamos lastSuccessfulActivity: si esto persiste, el watchdog
        // reiniciara el proceso al superar STALL_LIMIT_MS.
        if (!reconnecting) {
          console.log("[polling] Error temporal de conexion; esperando reconexion automatica (watchdog activo)...");
        }
      } else if (msgErr && (msgErr.includes("SESSION_REVOKED") || msgErr.includes("AUTH_KEY_UNREGISTERED") || (err.code && err.code === 401))) {
        clearInterval(timer);
        clearInterval(watchdog);
        console.error("[SESSION_REVOKED] Sesion de Telegram revocada. Regenera la sesion localmente, actualiza SESSION en Railway y haz redeploy.");
        try {
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: String(TELEGRAM_CHAT_ID),
            text: "⚠️ *Sesión de Telegram revocada.*\n\nEl forwarder dejó de funcionar.\n\n*Pasos para restaurarlo:*\n1. Corré `npm start` localmente\n2. Autenticáte con tu teléfono\n3. Copiá el contenido de `session.txt`\n4. Actualizá la variable `SESSION` en Railway\n5. Hacé redeploy",
            parse_mode: "Markdown",
          });
        } catch (notifyErr) {
          console.error("[SESSION_REVOKED] No se pudo enviar notificacion al bot:", notifyErr.message);
        }
      } else {
        console.error("Error al consultar mensajes:", err.message);
      }
    } finally {
      isPolling = false;
    }
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("\nError fatal:", err.message);
  process.exit(1);
});
