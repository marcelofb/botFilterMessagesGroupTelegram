# telegram-forwarder

Reenvía automáticamente los mensajes de un usuario específico en un grupo de Telegram hacia otro chat o bot.

## ¿Cómo funciona?

El script se conecta a tu cuenta de Telegram usando la API MTProto, monitorea un grupo y reenvía en tiempo real (polling cada 5 segundos) todos los mensajes de un usuario determinado a tu chat personal vía bot.

Cuando el mensaje es una respuesta, se envía primero la cadena completa de mensajes previos del hilo (con el username de cada remitente) para que puedas entender el contexto.

## Requisitos

- [Node.js](https://nodejs.org/) v18 o superior
- Una cuenta de Telegram
- Credenciales de la API de Telegram (API_ID y API_HASH)

## Obtener las credenciales de Telegram

1. Ingresá a [https://my.telegram.org](https://my.telegram.org) con tu número de teléfono
2. Ir a **API development tools**
3. Crear una nueva aplicación (el nombre y la plataforma pueden ser cualquier cosa)
4. Copiar el **App api_id** y el **App api_hash**

## Instalación

```bash
git clone https://github.com/tu-usuario/telegram-forwarder.git
cd telegram-forwarder
npm install
```

## Configuración

Copiá el archivo de ejemplo y completá los valores:

```bash
cp .env.example .env
```

Editá el archivo `.env`:

```env
API_ID=tu_api_id
API_HASH=tu_api_hash

SOURCE_GROUP=-1001234567890      # ID o username del grupo a monitorear
SOURCE_USER=username_del_usuario # Username del usuario a seguir (sin @)

BOT_TOKEN=123456:ABC-DEF...      # Token del bot obtenido en @BotFather
TELEGRAM_CHAT_ID=123456789       # Tu ID numérico personal (obtenelo con @userinfobot)
```

### Descubrir el ID de un grupo

Si no sabés el ID numérico del grupo, podés listarlo con:

```bash
npm run list
```

Esto imprime todos tus grupos y canales con sus IDs.

## Uso

```bash
npm start
```

Al iniciarse por primera vez pedirá el número de teléfono y el código de verificación de Telegram. La sesión se guarda en `session.txt` para no tener que volver a autenticarse.

## Comandos

| Comando | Descripción |
|---|---|
| `npm start` | Inicia el forwarder |
| `npm run list` | Lista todos los grupos/canales con sus IDs |

## Despliegue en Google Cloud (Free Tier)

El bot corre en una VM `e2-micro` de Google Cloud, que es gratuita de por vida en las regiones `us-central1`, `us-west1` o `us-east1`.

### Aplicar cambios tras un push al repo

Conectarse a la VM vía SSH (botón SSH en Google Cloud Console) y ejecutar:

```bash
cd telegram-forwarder
git pull
pm2 restart telegram-forwarder
```

### Verificar que está corriendo

```bash
pm2 status
pm2 logs telegram-forwarder
```

### Actualizar la sesión de Telegram

Si la sesión expira o se invalida, regenerarla localmente:

```bash
# En tu máquina local — asegurate de que SESSION= esté vacío en .env
del session.txt
node index.js
# Autenticáte con teléfono y código, luego Ctrl+C
```

Copiar el contenido del nuevo `session.txt` y en la VM:

```bash
nano .env   # actualizar SESSION= con el nuevo valor
rm -f session.txt
pm2 restart telegram-forwarder
```

## Seguridad

- **No compartas** el archivo `.env` ni `session.txt`. Contienen tus credenciales y sesión de Telegram.
- Ambos archivos están excluidos del repositorio por `.gitignore`.

## Licencia

MIT
