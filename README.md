# telegram-forwarder

Reenvía automáticamente los mensajes de un usuario específico en un grupo de Telegram hacia otro chat o bot.

## ¿Cómo funciona?

El script se conecta a tu cuenta de Telegram usando la API MTProto, monitorea un grupo y reenvía en tiempo real (polling cada 5 segundos) todos los mensajes de un usuario determinado al destino que configures.

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

SOURCE_GROUP=-1001234567890   # ID o username del grupo a monitorear
SOURCE_USER=username_del_usuario  # Username del usuario a seguir (sin @)
DEST_CHAT=@tu_bot_o_chat     # Destino de los mensajes reenviados
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

## Seguridad

- **No compartas** el archivo `.env` ni `session.txt`. Contienen tus credenciales y sesión de Telegram.
- Ambos archivos están excluidos del repositorio por `.gitignore`.

## Licencia

MIT
