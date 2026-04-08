const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const SESSION_FILE = path.join(__dirname, "session.txt");

function loadSession() {
  if (fs.existsSync(SESSION_FILE)) return fs.readFileSync(SESSION_FILE, "utf-8").trim();
  return process.env.SESSION || "";
}

function saveSession(str) {
  fs.writeFileSync(SESSION_FILE, str, "utf-8");
}

// Acepta username (con o sin @) o ID numérico como string
function resolveId(value) {
  if (/^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  const clean = value.trim().replace(/^@/, "");
  return `@${clean}`;
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

  const { SOURCE_GROUP, SOURCE_USER, DEST_CHAT } = process.env;

  if (!SOURCE_GROUP || !SOURCE_USER || !DEST_CHAT) {
    console.error("\nError: SOURCE_GROUP, SOURCE_USER y DEST_CHAT son requeridos en .env\n");
    process.exit(1);
  }

  let groupEntity, userEntity, destEntity;

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

  try {
    destEntity = await client.getEntity(resolveId(DEST_CHAT));
  } catch (e) {
    console.error(`No se pudo resolver DEST_CHAT="${DEST_CHAT}": ${e.message}`);
    process.exit(1);
  }

  const targetId = userEntity.id.toString();
  const groupName = groupEntity.title || groupEntity.username;
  const destName = destEntity.title || destEntity.username || String(destEntity.id);

  console.log(`\nEscuchando en:    "${groupName}"`);
  console.log(`Filtrando usuario: @${userEntity.username} (ID: ${targetId})`);
  console.log(`Reenviando a:      "${destName}"\n`);

  // Inicializa el estado de updates del servidor
  await client.getDialogs({ limit: 10 });

  console.log("Activo. Presioná Ctrl+C para detener.\n");

  // Obtener el ID del último mensaje para no reenviar mensajes viejos
  const initialMessages = await client.getMessages(groupEntity, { limit: 1 });
  let lastSeenId = initialMessages.length > 0 ? initialMessages[0].id : 0;
  console.log(`Último mensaje conocido del grupo: ID ${lastSeenId}\n`);

  const POLL_INTERVAL_MS = 5000; // consultar cada 5 segundos

  setInterval(async () => {
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
          await client.forwardMessages(destEntity, {
            messages: [msg.id],
            fromPeer: groupEntity,
          });
          const timestamp = new Date().toLocaleString("es-AR");
          console.log(`[${timestamp}] Mensaje reenviado (msg ID: ${msg.id})`);
        } catch (err) {
          console.error(`Error al reenviar mensaje ID ${msg.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error("Error al consultar mensajes:", err.message);
    }
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("\nError fatal:", err.message);
  process.exit(1);
});
