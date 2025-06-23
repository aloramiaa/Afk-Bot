const mineflayer = require('mineflayer');
const Movements = require('mineflayer-pathfinder').Movements;
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const { GoalBlock, GoalXZ } = require('mineflayer-pathfinder').goals;

const config = require('./settings.json');

const loggers = require('./logging.js');
const logger = loggers.logger;

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
   res.send('Bot is running!');
});

const server = app.listen(port, () => {
   logger.info(`Server listening on port ${port}`);
   createBot();
});

server.on('error', (err) => {
   if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${port} is already in use. Another instance of the bot may be running.`);
      process.exit(1);
   } else {
      logger.error('An unexpected error occurred with the web server:', err);
   }
});

let isReconnecting = false;
let currentUsernameIndex = 0;
let activeIntervals = [];

const handleDisconnect = () => {
   if (isReconnecting || !config.utils['auto-reconnect']) return;
   isReconnecting = true;
   setTimeout(createBot, config.utils['auto-reconnect-delay']);
};

process.on('uncaughtException', (err) => {
   logger.error('Unhandled Exception:', err);
   logger.warn(`Bot is restarting due to an uncaught exception...`);
   handleDisconnect();
});

function createBot() {
   isReconnecting = false;

   const trackInterval = (callback, delay) => {
      const id = setInterval(callback, delay);
      activeIntervals.push(id);
   };

   const bot = mineflayer.createBot({
      username: config['bot-account']['usernames'][currentUsernameIndex],
      password: config['bot-account']['password'],
      auth: config['bot-account']['type'],
      host: config.server.ip,
      port: config.server.port,
      version: config.server.version,
      checkTimeoutInterval: 60 * 1000,
   });

   bot.loadPlugin(pathfinder);
   const mcData = require('minecraft-data')(bot.version);
   const defaultMove = new Movements(bot, mcData);
   bot.settings.colorsEnabled = false;
   bot.pathfinder.setMovements(defaultMove);

   bot.once('spawn', () => {
      logger.info("Bot joined to the server");

      if (config.utils['auto-auth'].enabled) {
         logger.info('Started auto-auth module');

         let password = config.utils['auto-auth'].password;
         setTimeout(() => {
            bot.chat(`/register ${password} ${password}`);
            bot.chat(`/login ${password}`);
         }, 500);

         logger.info(`Authentication commands executed`);
      }

      if (config.utils['chat-messages'].enabled) {
         logger.info('Started chat-messages module');

         let messages = config.utils['chat-messages']['messages'];

         if (config.utils['chat-messages'].repeat) {
            let delay = config.utils['chat-messages']['repeat-delay'];
            let i = 0;

            trackInterval(() => {
               bot.chat(`${messages[i]}`);

               if (i + 1 === messages.length) {
                  i = 0;
               } else i++;
            }, delay * 1000);
         } else {
            messages.forEach((msg) => {
               bot.chat(msg);
            });
         }
      }

      const pos = config.position;

      if (config.position.enabled) {
         logger.info(
             `Starting moving to target location (${pos.x}, ${pos.y}, ${pos.z})`
         );
         bot.pathfinder.setGoal(new GoalBlock(pos.x, pos.y, pos.z));
      }

      if (config.utils['anti-afk'].enabled) {
         if (config.utils['anti-afk'].sneak) {
            bot.setControlState('sneak', true);
         }

         if (config.utils['anti-afk'].jump) {
            bot.setControlState('jump', true);
         }

         if (config.utils['anti-afk']['hit'].enabled) {
            let delay = config.utils['anti-afk']['hit']['delay'];
            let attackMobs = config.utils['anti-afk']['hit']['attack-mobs']

            trackInterval(() => {
               if(attackMobs) {
                     let entity = bot.nearestEntity(e => e.type !== 'object' && e.type !== 'player'
                         && e.type !== 'global' && e.type !== 'orb' && e.type !== 'other');

                     if(entity) {
                        bot.attack(entity);
                        return
                     }
               }

               bot.swingArm("right", true);
            }, delay);
         }

         if (config.utils['anti-afk'].rotate) {
            trackInterval(() => {
               bot.look(bot.entity.yaw + 1, bot.entity.pitch, true);
            }, 100);
         }

         if (config.utils['anti-afk']['circle-walk'].enabled) {
            let radius = config.utils['anti-afk']['circle-walk']['radius']
            circleWalk(bot, radius, trackInterval);
         }
      }

      if (config.position.enabled) {
         logger.info(
             `Bot arrived to target location. ${bot.entity.position}`
         );
      }
   });

   bot.on('chat', (username, message) => {
      if (config.utils['chat-log']) {
         logger.info(`<${username}> ${message}`);
      }
   });

   bot.on('death', () => {
      logger.warn(
         `Bot has been died and was respawned at ${bot.entity.position}`
      );
   });

   bot.on('end', () => {
      activeIntervals.forEach(clearInterval);
      activeIntervals = [];
      logger.warn(`Bot has disconnected. Reconnecting in ${config.utils['auto-reconnect-delay'] / 1000} seconds...`);
      handleDisconnect();
   });

   bot.on('kicked', (reason) => {
      let reasonText = 'Could not parse kick reason.';
      try {
        const parsedReason = JSON.parse(reason);
        if (parsedReason.text) {
            reasonText = parsedReason.text;
        } else if (parsedReason.extra && parsedReason.extra.length > 0) {
            reasonText = parsedReason.extra.map(p => p.text).join('');
        } else {
            reasonText = reason;
        }
      } catch (e) {
        reasonText = reason;
      }

      if(typeof reasonText !== 'string'){
        reasonText = String(reasonText);
      }
      reasonText = reasonText.replace(/§./g, '');

      logger.warn(`Bot was kicked from the server. Reason: ${reasonText}`);
      
      if (reasonText.includes('You have been idle for too long') || reasonText.includes('Someone with your name is already online') || reasonText.includes('You are banned from this server')) {
         currentUsernameIndex++;
         if (currentUsernameIndex >= config['bot-account']['usernames'].length) {
            currentUsernameIndex = 0;
         }
         logger.info(`Switching to next username: ${config['bot-account']['usernames'][currentUsernameIndex]}`);
      }

      handleDisconnect();
   });

   bot.on('error', (err) => {
      logger.error(err);
      handleDisconnect();
   });
}

function circleWalk(bot, radius, trackInterval) {
   // Make bot walk in square with center in bot's  wthout stopping
    return new Promise(() => {
        const pos = bot.entity.position;
        const x = pos.x;
        const y = pos.y;
        const z = pos.z;

        const points = [
            [x + radius, y, z],
            [x, y, z + radius],
            [x - radius, y, z],
            [x, y, z - radius],
        ];

        let i = 0;
        trackInterval(() => {
             if(i === points.length) i = 0;
             bot.pathfinder.setGoal(new GoalXZ(points[i][0], points[i][2]));
             i++;
        }, 1000);
    });
}

// createBot();
