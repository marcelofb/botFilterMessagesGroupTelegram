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
      connectionRetries: 5,
      requestRetries: 5,
      autoReconnect: true,
      sequentialUpdates: true,
    }
  );

  let reconnecting = false;
  let seenConnectedState = false;

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
        console.log("[conexion] Conexion en estado inestable.");
        reconnecting = true;
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

  const timer = setInterval(async () => {
    try {
      const messages = await client.getMessages(groupEntity, {
        limit: 20,
        minId: lastSeenId,
      });

      // getMessages devuelve del más reciente al más viejo; procesar en orden cronológico
      const ordered = messages.slice().reverse();

      for (const msg of ordered) {
        if (msg.id <= lastSeenId) continue;
        lastSeenId = msg.id;

        const senderId = msg.senderId ? msg.senderId.toString() : null;
        if (senderId !== targetId) continue;

        try {
          const replyToMsgId = msg.replyTo?.replyToMsgId ?? null;

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
          if (enviado) {
            const timestamp = new Date().toLocaleString("es-AR");
            console.log(`[${timestamp}] Mensaje enviado (msg ID: ${msg.id})${replyToMsgId ? " [con contexto de respuesta]" : ""}`);
          }
        } catch (err) {
          console.error(`Error al enviar mensaje ID ${msg.id}:`, err.message);
        }
      }
    } catch (err) {
      if (err.message === "TIMEOUT" || err.message === "Not connected") {
        if (!reconnecting) {
          console.log("[polling] Error temporal de conexion; esperando reconexion automatica...");
        }
      } else if (err.message && (err.message.includes("SESSION_REVOKED") || err.message.includes("AUTH_KEY_UNREGISTERED") || (err.code && err.code === 401))) {
        clearInterval(timer);
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
    }
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("\nError fatal:", err.message);
  process.exit(1);
});
