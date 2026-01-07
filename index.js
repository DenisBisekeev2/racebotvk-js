const { VK, Keyboard } = require('vk-io');
const fs = require('fs-extra');
const path = require('path');
const express = require('express'); 
// Конфигурация
const CONFIG = {
    BOT_TOKEN: 'vk1.a.MTzBXxQQyLu72tOMdVYarZLJ3yOOmHXJ2d-MIyWIw55LLJnAryrh1ueQTmh7lsmNXYYyLaU8c59brz9S2gBZ1YK_5HYujr809X2mn7N8OlHwOGiIVOzRJJQ1f_9tjsCquwGdHcKKBQ94Bx1TjKl3hQOX0iLel_1FNwgJ7ycrrK2efdNyrdXlqb31SpXpFk_ChGJDWnLnU6moOlIsVKQvtA',
    GROUP_ID: 233724428,
    RACE_DISTANCE: 1000,
    GLOBAL_RACE_DISTANCE: 1500,
    MAX_PLAYERS: 10,
    MAX_PREMIUM_PLAYERS: 15,
    MIN_PLAYERS: 2,
    UPDATE_INTERVAL: 2,
    GLOBAL_RACE_TIMEOUT: 900,
    LEVEL_REWARD: 500
};

// Инициализация VK
const vk = new VK({
    token: CONFIG.BOT_TOKEN,
    pollingGroupId: CONFIG.GROUP_ID,
    apiMode: 'parallel_selected'
});

// Глобальные переменные
const localRaces = new Map();
const dragRaces = new Map();
const pvpWaitingPlayers = new Map();
const pvpActiveRaces = new Map();
const databaseLogin = new Map();
const mechanicJobs = new Map(); // Работы автомеханика

// Утилиты
class Utils {
    static formatNumber(num) {
        return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    }

    static loadData(filename) {
        try {
            const filePath = path.join(__dirname, filename);
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error(`Error loading ${filename}:`, error);
        }
        
        // Возвращаем структуру по умолчанию для разных файлов
        if (filename.includes('users')) return { users: {} };
        if (filename.includes('chats')) return { chats: {} };
        if (filename.includes('cars')) return { cars_shop: {} };
        if (filename.includes('admin')) return { moders: { users_ids: [] }, ban: { users_ids: [] } };
        if (filename.includes('klans')) return { klans: {}, next_klan_id: 1 };
        return {};
    }

    static saveData(filename, data) {
        try {
            const filePath = path.join(__dirname, filename);
            fs.ensureDirSync(path.dirname(filePath));
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            return true;
        } catch (error) {
            console.error(`Error saving ${filename}:`, error);
            return false;
        }
    }

    static async getUserInfo(userId) {
        try {
            const [user] = await vk.api.users.get({
                user_ids: userId,
                fields: 'first_name,last_name,photo_200'
            });
            return user;
        } catch (error) {
            console.error('Error getting user info:', error);
            return { first_name: 'Пользователь', last_name: '' };
        }
    }

    static extractUserId(text) {
        if (!text) return null;
        
        // Извлечение ID из упоминания [id123|Name]
        const mentionMatch = text.match(/\[id(\d+)\|/);
        if (mentionMatch) return parseInt(mentionMatch[1]);

        // Извлечение ID из ссылки vk.com/id123
        const linkMatch = text.match(/vk\.com\/(?:id(\d+)|([\w\.]+))/);
        if (linkMatch && linkMatch[1]) return parseInt(linkMatch[1]);

        // Если это просто число
        if (/^\d+$/.test(text)) return parseInt(text);

        return null;
    }

    static createKeyboard(buttons, inline = true) {
        const keyboard = Keyboard.builder();
        
        if (inline) {
            keyboard.inline();
        }
        
        buttons.forEach(row => {
            keyboard.row();
            row.forEach(button => {
                if (button.link) {
                    keyboard.urlButton({
                        label: button.label,
                        url: button.link
                    });
                } else {
                    // ВСЕ КНОПКИ - ОБЫЧНЫЕ ТЕКСТОВЫЕ (даже в inline режиме)
                    keyboard.textButton({
                        label: button.label,
                        payload: button.payload ? JSON.stringify(button.payload) : JSON.stringify({})
                    });
                }
            });
        });
        
        return keyboard;
    }

    static createCarouselKeyboard(items, user, callbackName, isShop = false) {
        const keyboard = Keyboard.builder();
        keyboard.inline();
        
        // Разделяем на ряды по 2 кнопки
        const entries = Object.entries(items);
        
        for (let i = 0; i < entries.length; i += 2) {
            const rowItems = entries.slice(i, i + 2);
            
            if (i > 0) {
                keyboard.row();
            }
            
            rowItems.forEach(([itemId, itemData]) => {
                let label;
                if (isShop) {
                    label = `${itemData.name} - ${Utils.formatNumber(itemData.price)}₽`;
                } else {
                    const isActive = user && user.active_car === itemId;
                    label = `${itemData.name}${isActive ? ' ✅' : ''}`;
                }
                
                // Обрезаем слишком длинные названия
                if (label.length > 35) {
                    label = label.substring(0, 32) + '...';
                }
                
                keyboard.textButton({
                    label: label,
                    payload: JSON.stringify({ 
                        cmd: callbackName, 
                        car_id: itemId 
                    })
                });
            });
        }
        
        return keyboard;
    }

    static checkBan(userId) {
        try {
            const adminData = this.loadData('admin.json');
            if (!adminData.ban?.users_ids?.includes(userId.toString())) {
                return null;
            }
            
            const banInfo = adminData.ban[userId.toString()];
            if (!banInfo) return null;
            
            const currentTime = Math.floor(Date.now() / 1000);
            const endTime = banInfo.time + (banInfo.days * 24 * 60 * 60);
            const remaining = endTime - currentTime;
            
            return {
                banned: true,
                info: banInfo,
                endTime,
                remaining,
                expired: remaining <= 0
            };
        } catch (error) {
            console.error('Error checking ban:', error);
            return null;
        }
    }
}

// Классы
class Race {
    constructor(raceId, chatId, creatorId, isGlobal = false) {
        this.raceId = raceId;
        this.chatId = chatId;
        this.creatorId = creatorId;
        this.isGlobal = isGlobal;
        this.players = new Map();
        this.status = "waiting";
        this.startTime = null;
        this.distance = isGlobal ? CONFIG.GLOBAL_RACE_DISTANCE : CONFIG.RACE_DISTANCE;
        this.messageId = null;
        this.creationTime = Date.now() / 1000;
    }

    addPlayer(userId, userName, carData) {
        if (this.status !== "waiting") {
            return { success: false, message: "Гонка уже началась!" };
        }

        const maxPlayers = this.isChatPremium() ? CONFIG.MAX_PREMIUM_PLAYERS : CONFIG.MAX_PLAYERS;
        if (this.players.size >= maxPlayers) {
            return { success: false, message: "Достигнут лимит игроков!" };
        }

        if (this.players.has(userId)) {
            return { success: false, message: "Вы уже участвуете в гонке!" };
        }

        this.players.set(userId, {
            userName: userName,
            car: carData,
            progress: 0,
            speed: 0,
            finished: false,
            position: 0,
            finishTime: null
        });

        return { success: true, message: "Игрок добавлен!" };
    }

    removePlayer(userId) {
        return this.players.delete(userId);
    }

    startRace(userId) {
        if (userId !== this.creatorId) {
            return { success: false, message: "Только создатель гонки может её начать!" };
        }

        if (this.players.size < CONFIG.MIN_PLAYERS) {
            return { success: false, message: `Недостаточно игроков! Минимум: ${CONFIG.MIN_PLAYERS}` };
        }

        this.status = "in_progress";
        this.startTime = Date.now() / 1000;
        return { success: true, message: "Гонка началась!" };
    }

    updateRace() {
        if (this.status !== "in_progress") return false;

        let raceFinished = true;

        for (const [userId, player] of this.players) {
            if (player.finished) continue;

            player.speed = this.calculateSpeed(player);
            player.progress += player.speed;

            if (player.progress >= this.distance) {
                player.finished = true;
                player.progress = this.distance;
                player.finishTime = (Date.now() / 1000) - this.startTime;
            } else {
                raceFinished = false;
            }
        }

        if (raceFinished) {
            this.status = "finished";
            this.calculateResults();
            return true;
        }

        return false;
    }

    calculateSpeed(playerData) {
        const car = playerData.car;
        const baseSpeed = car.max_speed * 0.3;
        const hpBoost = car.hp * 0.002;
        const tireEffect = car.tire_health / 100;
        const durabilityEffect = (car.durability || 100) / 100;
        const randomFactor = 0.9 + Math.random() * 0.2;

        return (baseSpeed + hpBoost) * tireEffect * durabilityEffect * randomFactor;
    }

    calculateResults() {
        const results = [];
        for (const [userId, player] of this.players) {
            results.push({
                userId,
                finishTime: player.finished ? player.finishTime : Infinity,
                progress: player.progress
            });
        }

        results.sort((a, b) => {
            if (b.progress !== a.progress) return b.progress - a.progress;
            return a.finishTime - b.finishTime;
        });

        for (let i = 0; i < results.length; i++) {
            const player = this.players.get(results[i].userId);
            if (player) player.position = i + 1;
        }
    }

    isChatPremium() {
        const chatsData = Utils.loadData('chats.json');
        const chatInfo = chatsData.chats?.[this.chatId] || {};
        return chatInfo.premium || false;
    }

    getRaceInfo() {
        if (this.status === "waiting") {
            let text = "🏎️ ГОНКА ОЖИДАЕТ ИГРОКОВ\n\n";
            text += `📍 Дистанция: ${Utils.formatNumber(this.distance)}м\n`;
            text += `👥 Участников: ${this.players.size}/${this.isChatPremium() ? CONFIG.MAX_PREMIUM_PLAYERS : CONFIG.MAX_PLAYERS}\n`;
            text += `🎯 Необходимо минимум: ${CONFIG.MIN_PLAYERS}\n\n`;

            if (this.players.size > 0) {
                text += "Участники:\n";
                for (const [userId, player] of this.players) {
                    text += `• ${player.userName} - ${player.car.name}\n`;
                }
            } else {
                text += "Пока нет участников\n";
            }

            return text;
        } else if (this.status === "in_progress") {
            let text = "🏁 ГОНКА В ПРОЦЕССЕ!\n\n";
            const sortedPlayers = Array.from(this.players.entries())
                .sort((a, b) => b[1].progress - a[1].progress);

            sortedPlayers.forEach(([userId, player], i) => {
                const progressPercent = Math.min(100, Math.floor(player.progress / this.distance * 100));
                const progressBars = Math.floor(progressPercent / 5);
                const progressBar = "█".repeat(progressBars) + "▒".repeat(20 - progressBars);

                const status = player.finished ? 
                    `🏁 ФИНИШ (${player.finishTime.toFixed(1)}с)` : 
                    `🚗 ${progressPercent}%`;

                text += `${i+1}. ${player.userName}\n   ${progressBar} ${status}\n`;
            });

            return text;
        } else {
            let text = "🏆 ГОНКА ЗАВЕРШЕНА!\n\nРЕЗУЛЬТАТЫ:\n\n";
            const sortedPlayers = Array.from(this.players.entries())
                .sort((a, b) => a[1].position - b[1].position);

            sortedPlayers.forEach(([userId, player]) => {
                let positionEmoji;
                if (player.position === 1) positionEmoji = "🥇";
                else if (player.position === 2) positionEmoji = "🥈";
                else if (player.position === 3) positionEmoji = "🥉";
                else positionEmoji = `${player.position}.`;

                const status = player.finished ? `${player.finishTime.toFixed(1)}с` : "Не финишировал";

                text += `${positionEmoji} ${player.userName} - ${player.car.name} (${status})\n`;
            });

            return text;
        }
    }
}

// Основной обработчик бота
class BotHandler {
    static async handleMessage(context) {
        try {
            const text = context.text?.toLowerCase() || '';
            const userId = context.senderId;
            const peerId = context.peerId;

            console.log(`Message from ${userId}: ${text}`);

            // Проверка бана при любой команде
            if (text && text.trim() !== '') {
                const banCheck = Utils.checkBan(userId.toString());
                if (banCheck?.banned && !banCheck.expired) {
                    const endDate = new Date(banCheck.endTime * 1000).toLocaleString('ru-RU');
                    const daysLeft = Math.floor(banCheck.remaining / (24 * 60 * 60));
                    const hoursLeft = Math.floor((banCheck.remaining % (24 * 60 * 60)) / 3600);
                    
                    await context.send(
                        `🚫 Вы заблокированы!\n\n` +
                        `📅 До: ${endDate}\n` +
                        `⏰ Осталось: ${daysLeft} дн. ${hoursLeft} час.\n` +
                        `📝 Причина: ${banCheck.info.reason}`
                    );
                    return;
                }
            }

            // Регистрируем чат если это групповой чат
            if (peerId !== userId) {
                this.registerChat(context);
            }

            // Обработка текстовых команд
            if (['меню', '/start', 'start', 'начать'].includes(text)) {
                await this.showMenu(context);
            } else if (['помощь', 'команды', 'help'].includes(text)) {
                await this.showCommands(context);
            } else if (['гонка', 'гонки', 'race'].includes(text)) {
                await this.showRaces(context);
            } else if (['старт', 'начать гонку'].includes(text)) {
                await this.startRace(context);
            } else if (['гараж', 'garage'].includes(text)) {
                await this.showGarage(context);
            } else if (['автосалон', 'магазин', 'shop'].includes(text)) {
                await this.showCarsShop(context);
            } else if (['техцентр', 'сервис', 'service'].includes(text)) {
                await this.showService(context);
            } else if (['глобальные гонки', 'глобальные', 'global'].includes(text)) {
                await this.showGlobalRaces(context);
            } else if (['мои результаты', 'статистика', 'stats'].includes(text)) {
                await this.myResults(context);
            } else if (['выйти из гонки', 'покинуть гонку'].includes(text)) {
                await this.leaveRace(context);
            } else if (text.startsWith('драг')) {
                await this.handleDragRace(context);
            } else if (text.startsWith('/admin')) {
                await this.handleAdminCommand(context);
            } else if (text === 'мой айди') {
                await context.send(`Ваш ID: ${userId}`);
            } else if (text === 'поддержка') {
                await context.send('Если у вас возникли какие-то проблемы, обращайтесь к - @deniska_bisekeev');
            } else if (text === 'вход') {
                await this.handleLogin(context);
            } else if (text === 'донат') {
                await this.showDonate(context);
            } else if (text.startsWith('клан')) {
                await this.handleKlanCommand(context, text);
            } else if (text.startsWith('битва присоединиться')) {
                await this.joinKlanBattle(context, text);
            } else if (text.startsWith('рассылка')) {
                await this.handleBroadcast(context);
            } else if (text === 'айди чата') {
                await context.send(`ID чата: ${peerId}`);
            } else if (text === 'выбрать машину') {
                await this.selectCar(context);
            } else if (text === 'автомеханик' || text === 'работа') {
                await this.showAutoMechanic(context);
            } else if (text === '1х1' || text === '1x1' || text === 'pvp') {
                await this.handlePvpCommand(context);
            } else if (text === 'начать работу' || text === 'искать работу') {
                await this.startMechanicJob(context);
            } else if (text === 'моя работа' || text === 'работать') {
                await this.continueMechanicJob(context);
            } else if (text === 'сменить работу' || text === 'новая работа') {
                await this.changeMechanicJob(context);
            } else if (text === 'завершить работу' || text === 'закончить') {
                await this.finishMechanicJob(context);
            } else if (peerId == userId) {
                // В личных сообщениях при неизвестной команде показываем меню
                await this.showMenu(context);
            }

            // Обработка команд из payload (для кнопок)
            if (context.messagePayload) {
                let payload;
                try {
                    payload = JSON.parse(context.messagePayload);
                } catch (error) {
                    console.error('Error parsing payload:', error);
                    return;
                }
                
                const cmd = payload?.cmd;
                console.log(`Processing payload command: ${cmd}`, payload);

                if (cmd) {
                    switch (cmd) {
                        case 'select_car_nav':
    
                            await this.handleCarNavigation(context, payload);
                            break;
                        case 'cars_shop_nav':
                            
                            await this.handleShopNavigation(context, payload);
                            break;
                        case 'garage':
                            await this.showGarage(context);
                            break;
                        case 'cars_shop':
                            await this.showCarsShop(context);
                            break;
                        case 'service':
                            await this.showService(context);
                            break;
                        case 'global_races':
                            await this.showGlobalRaces(context);
                            break;
                        case 'buy_car':
                            await this.buyCar(context, payload.car_id);
                            break;
                        case 'repair_tires':
                            await this.repairTires(context);
                            break;
                        case 'repair_body':
                            await this.repairBody(context);
                            break;
                        case 'upgrade_engine':
                            await this.upgradeEngine(context);
                            break;
                        case 'upgrade_speed':
                            await this.upgradeSpeed(context);
                            break;
                        case 'select_car':
                            await this.selectCar(context);
                            break;
                        case 'set_active_car':
                            await this.setActiveCar(context, payload.car_id);
                            break;
                        case 'create_race':
                            await this.createRace(context);
                            break;
                        case 'start_race':
                            await this.startRace(context);
                            break;
                        case 'race_status':
                            await this.showRaceStatus(context);
                            break;
                        case 'find_global_race':
                            await this.findGlobalRace(context);
                            break;
                        case 'my_results':
                            await this.myResults(context);
                            break;
                        case 'accept_drag':
                            await this.acceptDragRace(context, payload.drag_id);
                            break;
                        case 'decline_drag':
                            await context.send("❌ Вызов на драг-рейсинг отклонен.");
                            break;
                        case 'pvp_race':
                            await this.handlePvpCommand(context);
                            break;
                        case 'join_race':
                            await this.joinRace(context);
                            break;
                        case 'leave_race':
                            await this.leaveRace(context);
                            break;
                        case 'login':
                            await this.handleLoginCallback(context);
                            break;
                        case 'menu':
                            await this.showMenu(context);
                            break;
                        case 'auto_mechanic':
                            await this.showAutoMechanic(context);
                            break;
                        case 'start_job':
                            await this.startMechanicJob(context);
                            break;
                        case 'continue_job':
                            await this.continueMechanicJob(context);
                            break;
                        case 'change_job':
                            await this.changeMechanicJob(context);
                            break;
                        case 'finish_job':
                            await this.finishMechanicJob(context);
                            break;
                        
                        case 'car_nav_prev':
                            await this.handleCarNavPrev(context, payload.index);
                            break;
                        case 'car_nav_next':
                            await this.handleCarNavNext(context, payload.index);
                            break;
                        case 'shop_nav_prev':
                            await this.handleShopNavPrev(context, payload.index);
                            break;
                        case 'shop_nav_next':
                            await this.handleShopNavNext(context, payload.index);
                            break;
                        case 'car_nav_empty':
                        case 'shop_nav_empty':
                            // Пустая команда для неактивных кнопок
                            break;
                        case 'car_nav_info':
                        case 'shop_nav_info':
                            // Информационная кнопка
                            break;
                    }
                }
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    }

    static registerChat(context) {
        const chatsData = Utils.loadData('chats.json');
        const chatId = context.peerId.toString();

        if (!chatsData.chats) chatsData.chats = {};
        
        if (!chatsData.chats[chatId]) {
            chatsData.chats[chatId] = {
                title: context.chatTitle || "Чат",
                premium: false,
                registered_date: new Date().toISOString(),
                total_races: 0
            };
            Utils.saveData('chats.json', chatsData);
            console.log(`Chat ${chatId} registered`);
        }
    }
    static async handleCarNavigation(context, payload) {
        // Простая реализация - показываем меню выбора машины
        await this.selectCar(context);
    }

    static async handleShopNavigation(context, payload) {
        // Простая реализация - показываем магазин
        await this.showCarsShop(context);
    }
    static async handleCarNavPrev(context, currentIndex) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        const cars = user.cars || {};
        const carEntries = Object.entries(cars);
        
        const newIndex = Math.max(0, currentIndex - 1);
        await this.showCarPage(context, user, carEntries, newIndex);
    }

    static async handleCarNavNext(context, currentIndex) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        const cars = user.cars || {};
        const carEntries = Object.entries(cars);
        
        const newIndex = Math.min(carEntries.length - 1, currentIndex + 1);
        await this.showCarPage(context, user, carEntries, newIndex);
    }

    static async handleShopNavPrev(context, currentIndex) {
        const carsData = Utils.loadData('cars.json');
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        const cars = carsData.cars_shop || {};
        const carEntries = Object.entries(cars);
        
        const newIndex = Math.max(0, currentIndex - 1);
        await this.showShopPage(context, user, carEntries, newIndex);
    }

    static async handleShopNavNext(context, currentIndex) {
        const carsData = Utils.loadData('cars.json');
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        const cars = carsData.cars_shop || {};
        const carEntries = Object.entries(cars);
        
        const newIndex = Math.min(carEntries.length - 1, currentIndex + 1);
        await this.showShopPage(context, user, carEntries, newIndex);
    }
    static async showMenu(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await this.registerUser(context);
            return;
        }

        let text = "🏎️ ДОБРО ПОЖАЛОВАТЬ В ГОНОЧНЫЙ БОТ!\n\n";
        text += "Здесь вы можете участвовать в захватывающих гонках, покупать машины и улучшать их!\n\n";
        text += `💎 Ваш уровень: ${user.level}\n`;
        text += `📊 Опыт до следующего уровня: ${user.exp}/100\n`;
        text += `🚗 Машин в гараже: ${user.cars ? Object.keys(user.cars).length : 0}\n`;
        text += `💰 Баланс: ${Utils.formatNumber(user.money)} руб.\n\n`;
        text += "Выберите раздел:";

        const buttons = [
            [
                { label: "🚗 Гараж", payload: { cmd: 'garage' } },
                { label: "🏪 Автосалон", payload: { cmd: 'cars_shop' } }
            ],
            [
                { label: "🔧 Техцентр", payload: { cmd: 'service' } },
                { label: "🔩 Автомеханик", payload: { cmd: 'auto_mechanic' } }
            ]
        ];

        if (context.peerId === context.senderId) {
            buttons.push([
                { label: "🎮 1х1 Гонка", payload: { cmd: 'pvp_race' } },
                { label: "🌍 Глобальные гонки", payload: { cmd: 'global_races' } }
            ]);
        } else {
            buttons.push([
                { label: "🏎️ Создать гонку", payload: { cmd: 'create_race' } }
            ]);
        }

        const keyboard = Utils.createKeyboard(buttons, true);
        
        await context.send({
            message: text,
            keyboard: keyboard
        });
    }

    static async registerUser(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();

        if (usersData.users?.[userId]) {
            await this.showMenu(context);
            return;
        }

        // Проверка подписки на группу
        try {
            const isMember = await vk.api.groups.isMember({
                group_id: CONFIG.GROUP_ID,
                user_id: context.senderId
            });
            
            if (!isMember) {
                await context.send("🙃 Регистрация в боте невозможна, если вы не подписаны на него!");
                return;
            }
        } catch (error) {
            console.error('Error checking group membership:', error);
        }

        // Регистрация пользователя
        const userInfo = await Utils.getUserInfo(context.senderId);
        const username = userInfo ? `${userInfo.first_name} ${userInfo.last_name}` : 'Пользователь';

        if (!usersData.users) usersData.users = {};
        
        usersData.users[userId] = {
            username: username,
            money: 5000,
            exp: 0,
            level: 1,
            cars: {},
            active_car: null,
            referral_code: `ref_${userId}`,
            referred_by: null,
            pistons: 0,
            mechanic_level: 1,
            mechanic_exp: 0
        };

        Utils.saveData('users.json', usersData);

        await context.send({
            message: `😁 Отлично, ${userInfo.first_name}, регистрация прошла успешно!\n\n🎮 Теперь вы можете участвовать в гонках и покупать машины!\n\n⚠️ Чтобы начать участвовать в гонках, купите первую машину в автосалоне`,
            keyboard: Utils.createKeyboard([
                [
                    { label: "📚 Правила бота", link: "https://vk.com/@gonka_bot-rules" }
                ],
                [
                    { label: "➕ Добавить в чат", link: "https://vk.com/app6441755_-233724428" }
                ]
            ], true)
        });
    }

    static async showGarage(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ У вас нет аккаунта в боте! Напишите 'Начать' для регистрации.");
            return;
        }

        const cars = user.cars || {};
        if (Object.keys(cars).length === 0) {
            await context.send("❌ У вас нет машин! Посетите автосалон.");
            return;
        }

        let text = "🚗 ВАШ ГАРАЖ\n\n";
        let activeCarName = "Не выбрана";
        
        for (const [carId, carData] of Object.entries(cars)) {
            const activeIndicator = user.active_car === carId ? " ✅" : "";
            if (user.active_car === carId) {
                activeCarName = carData.name;
            }
            text += `🏁 ${carData.name}${activeIndicator}\n`;
            text += `   💪 ${Utils.formatNumber(carData.hp)} л.с. | 🚀 ${Utils.formatNumber(carData.max_speed)} км/ч\n`;
            text += `   🛞 Шины: ${carData.tire_health}% | 🛠️ Состояние: ${carData.durability}%\n\n`;
        }

        text += `🚘 Активная машина: ${activeCarName}\n`;
        text += `💰 Ваш баланс: ${Utils.formatNumber(user.money)} руб.`;

        const keyboard = Utils.createKeyboard([
            [
                { label: "📱 Выбрать машиу", payload: { cmd: 'select_car' } }
            ],
            [
                { label: "🏪 Автосалон", payload: { cmd: 'cars_shop' } },
                { label: "🔧 Техцентр", payload: { cmd: 'service' } }
            ],
            [
                { label: "🔩 Автомеханик", payload: { cmd: 'auto_mechanic' } },
                { label: "🏠 Меню", payload: { cmd: 'menu' } }
            ]
        ], true);
        
        await context.send({
            message: text,
            keyboard: keyboard
        });
    }

    static async selectCar(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        const cars = user.cars || {};
        if (Object.keys(cars).length === 0) {
            await context.send("❌ У вас нет машин! Посетите автосалон.");
            return;
        }

        // Получаем или создаем кэш для текущей позиции
        const carEntries = Object.entries(cars);
        const currentIndex = 0; // Начинаем с первой машины
        
        // Отправляем первое сообщение с навигацией
        await this.showCarPage(context, user, carEntries, currentIndex);
    }

    static async setActiveCar(context, carId) {
        if (!carId) {
            await this.selectCar(context);
            return;
        }

        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        if (!user.cars || !user.cars[carId]) {
            await context.send("❌ Машина не найдена!");
            return;
        }

        user.active_car = carId;
        Utils.saveData('users.json', usersData);

        const carData = user.cars[carId];
        
        // Показываем карусель с выбранной машиной
        const carousel = Keyboard.builder().carousel();
        
        const card = Keyboard.builder()
            .textButton({
                label: `✅ ${carData.name}`,
                payload: JSON.stringify({ cmd: 'set_active_car', car_id: carId })
            })
            .row()
            .textButton({
                label: `💪 ${Utils.formatNumber(carData.hp)} л.с.`,
                payload: JSON.stringify({ cmd: 'set_active_car', car_id: carId })
            })
            .textButton({
                label: `🚀 ${Utils.formatNumber(carData.max_speed)} км/ч`,
                payload: JSON.stringify({ cmd: 'set_active_car', car_id: carId })
            })
            .row()
            .textButton({
                label: `🛞 ${carData.tire_health}%`,
                payload: JSON.stringify({ cmd: 'set_active_car', car_id: carId })
            })
            .textButton({
                label: `🛠️ ${carData.durability}%`,
                payload: JSON.stringify({ cmd: 'set_active_car', car_id: carId })
            })
            .row()
            .textButton({
                label: '🚗 В гараж',
                payload: JSON.stringify({ cmd: 'garage' })
            })
            .textButton({
                label: '🏪 В магазин',
                payload: JSON.stringify({ cmd: 'cars_shop' })
            });

        carousel.addPage(card);

        await context.send({
            message: `⭐ ${carData.name} теперь ваша активная машина!`,
            keyboard: carousel
        });
    }

    static async showCarsShop(context) {
        const carsData = Utils.loadData('cars.json');
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        const cars = carsData.cars_shop || {};
        const carEntries = Object.entries(cars);

        if (carEntries.length === 0) {
            await context.send("❌ Машин пока нет в продаже!");
            return;
        }

        // Отправляем первое сообщение с навигацией
        await this.showShopPage(context, user, carEntries, 0);
    }

    static async showShopPage(context, user, carEntries, index) {
        if (index < 0 || index >= carEntries.length) {
            await context.send("❌ Ошибка навигации!");
            return;
        }

        const [carId, car] = carEntries[index];
        const canAfford = user.money >= car.price;
        
        let text = `🏪 АВТОСАЛОН (${index + 1}/${carEntries.length})\n\n`;
        text += `${car.name}\n`;
        text += `💪 ${Utils.formatNumber(car.hp)} л.с. | 🚀 ${Utils.formatNumber(car.max_speed)} км/ч\n`;
        text += `🛞 ${car.tire_health}% | 🛠️ ${car.durability}%\n`;
        text += `💰 Цена: ${Utils.formatNumber(car.price)} руб.\n\n`;
        text += `Ваш баланс: ${Utils.formatNumber(user.money)} руб.\n`;
        text += canAfford ? '✅ Доступно для покупки' : '❌ Недостаточно средств';

        const buttons = [];
        
        // Кнопка покупки
        buttons.push([
            { 
                label: canAfford ? `🛒 Купить за ${Utils.formatNumber(car.price)}₽` : `❌ ${Utils.formatNumber(car.price)}₽`,
                payload: canAfford ? { cmd: 'buy_car', car_id: carId } : { cmd: 'shop_nav_empty' }
            }
        ]);
        
        // Кнопки навигации
        const navButtons = [];
        
        if (index > 0) {
            navButtons.push({ 
                label: '⬅️', 
                payload: { cmd: 'shop_nav_prev', index: index } 
            });
        } else {
            navButtons.push({ 
                label: '◀️', 
                payload: { cmd: 'shop_nav_empty' } 
            });
        }
        
        // Индикатор позиции
        navButtons.push({ 
            label: `${index + 1}/${carEntries.length}`, 
            payload: { cmd: 'shop_nav_info' } 
        });
        
        if (index < carEntries.length - 1) {
            navButtons.push({ 
                label: '➡️', 
                payload: { cmd: 'shop_nav_next', index: index } 
            });
        } else {
            navButtons.push({ 
                label: '▶️', 
                payload: { cmd: 'shop_nav_empty' } 
            });
        }
        
        buttons.push(navButtons);
        
        // Дополнительные кнопки
        buttons.push([
            { label: '🚗 В гараж', payload: { cmd: 'garage' } },
            { label: '🏠 Меню', payload: { cmd: 'menu' } }
        ]);
        
        const keyboard = Utils.createKeyboard(buttons, true);
        
        // Если это первое сообщение, отправляем новое
        if (!context.messagePayload) {
            await context.send({
                message: text,
                keyboard: keyboard
            });
        } else {
            // Иначе редактируем существующее
            try {
                await context.editMessage({
                    message: text,
                    keyboard: keyboard
                });
            } catch (error) {
                console.error('Error editing message:', error);
                // Если нельзя редактировать, отправляем новое
                await context.send({
                    message: text,
                    keyboard: keyboard
                });
            }
        }
    }
    static async showCarPage(context, user, carEntries, index) {
        if (index < 0 || index >= carEntries.length) {
            await context.send("❌ Ошибка навигации!");
            return;
        }

        const [carId, carData] = carEntries[index];
        const isActive = user.active_car === carId;
        
        let text = `🚗 ВЫБЕРИТЕ АКТИВНУЮ МАШИНУ (${index + 1}/${carEntries.length})\n\n`;
        text += `${carData.name}${isActive ? ' ✅' : ''}\n`;
        text += `💪 ${Utils.formatNumber(carData.hp)} л.с. | 🚀 ${Utils.formatNumber(carData.max_speed)} км/ч\n`;
        text += `🛞 ${carData.tire_health}% | 🛠️ ${carData.durability}%\n\n`;
        text += "Используйте кнопки навигации для просмотра машин";

        const buttons = [];
        
        // Кнопка выбора
        buttons.push([
            { 
                label: isActive ? '✅ Выбрана' : '📱 Выбрать эту машину', 
                payload: { cmd: 'set_active_car', car_id: carId } 
            }
        ]);
        
        // Кнопки навигации
        const navButtons = [];
        
        if (index > 0) {
            navButtons.push({ 
                label: '⬅️', 
                payload: { cmd: 'car_nav_prev', index: index } 
            });
        } else {
            navButtons.push({ 
                label: '◀️', 
                payload: { cmd: 'car_nav_empty' } 
            });
        }
        
        // Индикатор позиции
        navButtons.push({ 
            label: `${index + 1}/${carEntries.length}`, 
            payload: { cmd: 'car_nav_info' } 
        });
        
        if (index < carEntries.length - 1) {
            navButtons.push({ 
                label: '➡️', 
                payload: { cmd: 'car_nav_next', index: index } 
            });
        } else {
            navButtons.push({ 
                label: '▶️', 
                payload: { cmd: 'car_nav_empty' } 
            });
        }
        
        buttons.push(navButtons);
        
        // Дополнительные кнопки
        buttons.push([
            { label: '🚗 В гараж', payload: { cmd: 'garage' } },
            { label: '🏠 Меню', payload: { cmd: 'menu' } }
        ]);
        
        const keyboard = Utils.createKeyboard(buttons, true);
        
        // Если это первое сообщение, отправляем новое
        if (!context.messagePayload) {
            await context.send({
                message: text,
                keyboard: keyboard
            });
        } else {
            // Иначе редактируем существующее
            try {
                await context.editMessage({
                    message: text,
                    keyboard: keyboard
                });
            } catch (error) {
                console.error('Error editing message:', error);
                // Если нельзя редактировать, отправляем новое
                await context.send({
                    message: text,
                    keyboard: keyboard
                });
            }
        }
    }
    static async buyCar(context, carId) {
        if (!carId) {
            await this.showCarsShop(context);
            return;
        }

        const carsData = Utils.loadData('cars.json');
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        const car = carsData.cars_shop?.[carId];
        if (!car) {
            await context.send("❌ Машина не найдена!");
            return;
        }

        if (user.money < car.price) {
            // Показываем карусель с ошибкой
            const errorCarousel = Keyboard.builder().carousel();
            
            const errorCard = Keyboard.builder()
                .textButton({
                    label: `❌ ${car.name}`,
                    payload: JSON.stringify({ cmd: 'buy_car', car_id: carId })
                })
                .row()
                .textButton({
                    label: `💪 ${Utils.formatNumber(car.hp)} л.с.`,
                    payload: JSON.stringify({ cmd: 'buy_car', car_id: carId })
                })
                .textButton({
                    label: `🚀 ${Utils.formatNumber(car.max_speed)} км/ч`,
                    payload: JSON.stringify({ cmd: 'buy_car', car_id: carId })
                })
                .row()
                .textButton({
                    label: `💰 Нужно: ${Utils.formatNumber(car.price)}₽`,
                    payload: JSON.stringify({ cmd: 'buy_car', car_id: carId })
                })
                .textButton({
                    label: `💸 Ваш баланс: ${Utils.formatNumber(user.money)}₽`,
                    payload: JSON.stringify({ cmd: 'buy_car', car_id: carId })
                })
                .row()
                .textButton({
                    label: '🏪 Вернуться в магазин',
                    payload: JSON.stringify({ cmd: 'cars_shop' })
                });

            errorCarousel.addPage(errorCard);

            await context.send({
                message: `❌ Недостаточно денег для покупки ${car.name}!`,
                keyboard: errorCarousel
            });
            return;
        }

        // Добавляем машину
        if (!user.cars) user.cars = {};
        const newCarId = (Object.keys(user.cars).length + 1).toString();
        
        user.cars[newCarId] = {
            name: car.name,
            hp: car.hp,
            max_speed: car.max_speed,
            tire_health: car.tire_health,
            durability: car.durability,
            bought_date: new Date().toISOString()
        };

        // Если это первая машина, делаем её активной
        if (Object.keys(user.cars).length === 1) {
            user.active_car = newCarId;
        }

        user.money -= car.price;
        Utils.saveData('users.json', usersData);

        // Показываем карусель с купленной машиной
        let message = `✅ Вы успешно купили ${car.name}!\n\n`;
        message += `💪 ${Utils.formatNumber(car.hp)} л.с. | 🚀 ${Utils.formatNumber(car.max_speed)} км/ч\n`;
        message += `🛞 ${car.tire_health}% | 🛠️ ${car.durability}%\n`;
        message += `💰 -${Utils.formatNumber(car.price)}₽ | 💸 Остаток: ${Utils.formatNumber(user.money)}₽`;

        if (Object.keys(user.cars).length === 1) {
            message += `\n\n⭐ Эта машина теперь ваша активная машина!`;
        }

        const keyboard = Utils.createKeyboard([
            [
                { label: '🚗 В гараж', payload: { cmd: 'garage' } },
                { label: '🏪 Ещё покупки', payload: { cmd: 'cars_shop' } }
            ]
        ], true);

        try {
            await context.editMessage({
                message: message,
                keyboard: keyboard
            });
        } catch (error) {
            await context.send({
                message: message,
                keyboard: keyboard
            });
        }
    }

    static async showService(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        if (!user.cars || Object.keys(user.cars).length === 0) {
            await context.send("❌ У вас нет машин!");
            return;
        }

        // Находим активную машину
        let activeCarId = user.active_car;
        const cars = user.cars;

        if (!activeCarId || !cars[activeCarId]) {
            activeCarId = Object.keys(cars)[0];
            user.active_car = activeCarId;
            Utils.saveData('users.json', usersData);
        }

        const car = cars[activeCarId];

        let text = `🔧 ТЕХЦЕНТР - ${car.name}\n\n`;
        text += `🛞 Шины: ${car.tire_health}%\n`;
        text += `🛠️ Состояние: ${car.durability}%\n\n`;
        text += "Услуги:\n";
        text += "🛞 Замена шин - 500 руб. (до 100%)\n";
        text += "🛠️ Ремонт кузова - 800 руб. (до 100%)\n";
        text += "💪 Улучшение двигателя - 2000 руб. (+10% л.с.)\n";
        text += "🚀 Улучшение скорости - 3000 руб. (+5% скорости)\n\n";
        text += `💰 Ваш баланс: ${Utils.formatNumber(user.money)} руб.`;

        const keyboard = Utils.createKeyboard([
            [
                { label: "🛞 Заменить шины", payload: { cmd: 'repair_tires' } },
                { label: "🛠️ Починить кузов", payload: { cmd: 'repair_body' } }
            ],
            [
                { label: "💪 Улучшить двигатель", payload: { cmd: 'upgrade_engine' } },
                { label: "🚀 Улучшить скорость", payload: { cmd: 'upgrade_speed' } }
            ],
            [
                { label: "🚗 Гараж", payload: { cmd: 'garage' } },
                { label: "🏠 Меню", payload: { cmd: 'menu' } }
            ]
        ], true);

        await context.send({
            message: text,
            keyboard: keyboard
        });
    }

    static async repairTires(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        if (!user.cars || Object.keys(user.cars).length === 0) {
            await context.send("❌ У вас нет машин!");
            return;
        }

        const activeCarId = user.active_car;
        if (!activeCarId || !user.cars[activeCarId]) {
            await context.send("❌ Сначала выберите активную машину!");
            return;
        }

        const car = user.cars[activeCarId];

        if (car.tire_health >= 100) {
            await context.send("❌ Шины и так в идеальном состоянии!");
            return;
        }

        const cost = 500;
        if (user.money < cost) {
            await context.send(`❌ Недостаточно денег! Нужно: ${cost} руб.`);
            return;
        }

        user.money -= cost;
        car.tire_health = 100;
        Utils.saveData('users.json', usersData);

        await context.send(`✅ Шины заменены! Состояние: 100% (-${cost} руб.)`);
        await this.showService(context);
    }

    static async repairBody(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        if (!user.cars || Object.keys(user.cars).length === 0) {
            await context.send("❌ У вас нет машин!");
            return;
        }

        const activeCarId = user.active_car;
        if (!activeCarId || !user.cars[activeCarId]) {
            await context.send("❌ Сначала выберите активную машину!");
            return;
        }

        const car = user.cars[activeCarId];

        if (car.durability >= 100) {
            await context.send("❌ Кузов и так в идеальном состоянии!");
            return;
        }

        const cost = 800;
        if (user.money < cost) {
            await context.send(`❌ Недостаточно денег! Нужно: ${cost} руб.`);
            return;
        }

        user.money -= cost;
        car.durability = 100;
        Utils.saveData('users.json', usersData);

        await context.send(`✅ Кузов отремонтирован! Состояние: 100% (-${cost} руб.)`);
        await this.showService(context);
    }

    static async upgradeEngine(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        if (!user.cars || Object.keys(user.cars).length === 0) {
            await context.send("❌ У вас нет машин!");
            return;
        }

        const activeCarId = user.active_car;
        if (!activeCarId || !user.cars[activeCarId]) {
            await context.send("❌ Сначала выберите активную машину!");
            return;
        }

        const car = user.cars[activeCarId];

        const cost = 2000;
        if (user.money < cost) {
            await context.send(`❌ Недостаточно денег! Нужно: ${cost} руб.`);
            return;
        }

        const hpIncrease = Math.floor(car.hp * 0.1);
        user.money -= cost;
        car.hp += hpIncrease;
        Utils.saveData('users.json', usersData);

        await context.send(`✅ Двигатель улучшен! +${Utils.formatNumber(hpIncrease)} л.с. (-${cost} руб.)`);
        await this.showService(context);
    }

    static async upgradeSpeed(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        if (!user.cars || Object.keys(user.cars).length === 0) {
            await context.send("❌ У вас нет машин!");
            return;
        }

        const activeCarId = user.active_car;
        if (!activeCarId || !user.cars[activeCarId]) {
            await context.send("❌ Сначала выберите активную машину!");
            return;
        }

        const car = user.cars[activeCarId];

        const cost = 3000;
        if (user.money < cost) {
            await context.send(`❌ Недостаточно денег! Нужно: ${cost} руб.`);
            return;
        }

        const speedIncrease = Math.floor(car.max_speed * 0.05);
        user.money -= cost;
        car.max_speed += speedIncrease;
        Utils.saveData('users.json', usersData);

        await context.send(`✅ Скорость улучшена! +${Utils.formatNumber(speedIncrease)} км/ч (-${cost} руб.)`);
        await this.showService(context);
    }

    static async showAutoMechanic(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        const job = mechanicJobs.get(userId);
        let hasActiveJob = job && job.status === 'working';

        let text = `🔩 АВТОМЕХАНИК - Работа\n\n`;
        text += `💰 Ваш баланс: ${Utils.formatNumber(user.money)} руб.\n`;
        text += `🏆 Уровень автомеханика: ${user.mechanic_level || 1}\n`;
        text += `📊 Опыт: ${user.mechanic_exp || 0}/${(user.mechanic_level || 1) * 100}\n\n`;

        if (hasActiveJob) {
            const jobProgress = Math.floor((Date.now() - job.startTime) / 60000); // в минутах
            const totalTime = job.requiredTime || 5;
            const progressPercent = Math.min(100, Math.floor((jobProgress / totalTime) * 100));
            
            text += `📋 Текущая работа:\n`;
            text += `   • ${job.type}\n`;
            text += `   • Клиент: ${job.clientName}\n`;
            text += `   • Оплата: ${Utils.formatNumber(job.reward)} руб.\n`;
            text += `   • Прогресс: ${jobProgress}/${totalTime} мин. (${progressPercent}%)\n\n`;
            
            text += `⏰ Вам нужно поработать еще ${totalTime - jobProgress} минут.\n`;
            text += `💪 После завершения вы получите ${Utils.formatNumber(job.reward)} руб. и опыт!\n`;
        } else {
            text += `🔧 Система работы автомеханика:\n`;
            text += `• Выполняйте работы по ремонту машин\n`;
            text += `• Зарабатывайте деньги и опыт\n`;
            text += `• Повышайте уровень автомеханика\n`;
            text += `• С каждым уровнем доступны более сложные и дорогие работы\n\n`;
            
            text += `📊 Ваш текущий уровень: ${user.mechanic_level || 1}\n`;
            text += `💰 Доступные заработки: ${Utils.formatNumber((user.mechanic_level || 1) * 500 - 300)} - ${Utils.formatNumber((user.mechanic_level || 1) * 500 + 300)} руб.\n`;
            text += `⏱️ Время работы: 5-15 минут\n\n`;
            
            text += `🎯 Начните работу, чтобы заработать деньги!`;
        }

        const keyboard = Utils.createKeyboard([
            [
                { label: "🔍 Начать работу", payload: { cmd: 'start_job' } }
            ]
        ], true);

        if (hasActiveJob) {
            keyboard.row();
            keyboard.textButton({
                label: "🛠️ Продолжить работу",
                payload: JSON.stringify({ cmd: 'continue_job' })
            });
            keyboard.row();
            keyboard.textButton({
                label: "🔄 Сменить работу",
                payload: JSON.stringify({ cmd: 'change_job' })
            });
            keyboard.textButton({
                label: "✅ Завершить",
                payload: JSON.stringify({ cmd: 'finish_job' })
            });
        }

        keyboard.row();
        keyboard.textButton({
            label: "🏠 Меню",
            payload: JSON.stringify({ cmd: 'menu' })
        });

        await context.send({
            message: text,
            keyboard: keyboard
        });
    }

    static async startMechanicJob(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        // Проверяем, не работает ли уже пользователь
        const existingJob = mechanicJobs.get(userId);
        if (existingJob && existingJob.status === 'working') {
            await context.send("❌ У вас уже есть активная работа!");
            await this.showAutoMechanic(context);
            return;
        }

        // Типы работ
        const jobTypes = [
            "Замена масла",
            "Ремонт двигателя",
            "Замена тормозных колодок",
            "Настройка подвески",
            "Ремонт коробки передач",
            "Покраска кузова",
            "Тюнинг выхлопной системы",
            "Установка спойлера",
            "Настройка карбюратора",
            "Ремонт электросистемы"
        ];

        // Клиенты
        const clients = [
            "Алексей Петров",
            "Дмитрий Иванов",
            "Сергей Смирнов",
            "Михаил Кузнецов",
            "Андрей Попов",
            "Иван Васильев",
            "Антон Новиков",
            "Владимир Морозов",
            "Евгений Волков",
            "Николай Соколов"
        ];

        const jobType = jobTypes[Math.floor(Math.random() * jobTypes.length)];
        const clientName = clients[Math.floor(Math.random() * clients.length)];
        const mechanicLevel = user.mechanic_level || 1;
        const baseReward = mechanicLevel * 500;
        const reward = Math.floor(baseReward * (0.8 + Math.random() * 0.4)); // +/- 20%
        const requiredTime = Math.floor(5 + Math.random() * 10); // 5-15 минут

        const job = {
            userId: userId,
            type: jobType,
            clientName: clientName,
            reward: reward,
            requiredTime: requiredTime,
            startTime: Date.now(),
            status: 'working'
        };

        mechanicJobs.set(userId, job);

        let text = `🔩 НАЧАТА НОВАЯ РАБОТА!\n\n`;
        text += `📋 Задание: ${jobType}\n`;
        text += `👤 Клиент: ${clientName}\n`;
        text += `💰 Оплата: ${Utils.formatNumber(reward)} руб.\n`;
        text += `⏱️ Время выполнения: ${requiredTime} минут\n`;
        text += `🏆 Опыт за выполнение: ${Math.floor(reward / 10)}\n\n`;
        text += `💡 Чтобы завершить работу, вернитесь через ${requiredTime} минут или используйте кнопку "Завершить" когда работа будет выполнена.`;

        const keyboard = Utils.createKeyboard([
            [
                { label: "🛠️ Продолжить работу", payload: { cmd: 'continue_job' } }
            ],
            [
                { label: "🔄 Сменить работу", payload: { cmd: 'change_job' } }
            ],
            [
                { label: "🔩 Автомеханик", payload: { cmd: 'auto_mechanic' } },
                { label: "🏠 Меню", payload: { cmd: 'menu' } }
            ]
        ], true);

        await context.send({
            message: text,
            keyboard: keyboard
        });
    }

    static async continueMechanicJob(context) {
        const userId = context.senderId.toString();
        const job = mechanicJobs.get(userId);

        if (!job || job.status !== 'working') {
            await context.send("❌ У вас нет активной работы!");
            await this.showAutoMechanic(context);
            return;
        }

        const elapsedMinutes = Math.floor((Date.now() - job.startTime) / 60000);
        const remainingMinutes = Math.max(0, job.requiredTime - elapsedMinutes);
        const progressPercent = Math.min(100, Math.floor((elapsedMinutes / job.requiredTime) * 100));

        let text = `🔩 ВАША РАБОТА\n\n`;
        text += `📋 Задание: ${job.type}\n`;
        text += `👤 Клиент: ${job.clientName}\n`;
        text += `💰 Оплата: ${Utils.formatNumber(job.reward)} руб.\n`;
        text += `⏱️ Прошло времени: ${elapsedMinutes} из ${job.requiredTime} минут\n`;
        text += `📊 Прогресс: ${progressPercent}%\n\n`;

        if (remainingMinutes > 0) {
            text += `⏰ Осталось работать: ${remainingMinutes} минут\n`;
            text += `💪 Продолжайте работу!`;
        } else {
            text += `✅ Работа выполнена! Вы можете завершить её и получить оплату.`;
        }

        const keyboard = Utils.createKeyboard([
            [
                { label: "✅ Завершить работу", payload: { cmd: 'finish_job' } }
            ],
            [
                { label: "🔄 Сменить работу", payload: { cmd: 'change_job' } }
            ],
            [
                { label: "🔩 Автомеханик", payload: { cmd: 'auto_mechanic' } },
                { label: "🏠 Меню", payload: { cmd: 'menu' } }
            ]
        ], true);

        await context.send({
            message: text,
            keyboard: keyboard
        });
    }

    static async changeMechanicJob(context) {
        const userId = context.senderId.toString();
        const job = mechanicJobs.get(userId);

        if (!job || job.status !== 'working') {
            await context.send("❌ У вас нет активной работы для смены!");
            await this.showAutoMechanic(context);
            return;
        }

        // Удаляем текущую работу
        mechanicJobs.delete(userId);
        
        await context.send("🔄 Текущая работа отменена. Вы можете начать новую работу.");
        await this.startMechanicJob(context);
    }

    static async finishMechanicJob(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];
        const job = mechanicJobs.get(userId);

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        if (!job || job.status !== 'working') {
            await context.send("❌ У вас нет активной работы для завершения!");
            await this.showAutoMechanic(context);
            return;
        }

        const elapsedMinutes = Math.floor((Date.now() - job.startTime) / 60000);
        
        if (elapsedMinutes < job.requiredTime) {
            const remainingMinutes = job.requiredTime - elapsedMinutes;
            await context.send(`❌ Работа еще не выполнена! Осталось работать: ${remainingMinutes} минут.`);
            await this.continueMechanicJob(context);
            return;
        }

        // Выплачиваем награду
        const reward = job.reward;
        const expReward = Math.floor(reward / 10);
        
        user.money += reward;
        user.mechanic_exp = (user.mechanic_exp || 0) + expReward;
        
        // Проверка повышения уровня автомеханика
        let levelUp = false;
        const expNeeded = (user.mechanic_level || 1) * 100;
        while (user.mechanic_exp >= expNeeded) {
            user.mechanic_level = (user.mechanic_level || 1) + 1;
            user.mechanic_exp -= expNeeded;
            levelUp = true;
        }

        // Удаляем завершенную работу
        mechanicJobs.delete(userId);
        
        Utils.saveData('users.json', usersData);

        let text = `🎉 РАБОТА ВЫПОЛНЕНА!\n\n`;
        text += `📋 Задание: ${job.type}\n`;
        text += `👤 Клиент: ${job.clientName}\n`;
        text += `💰 Получено: ${Utils.formatNumber(reward)} руб.\n`;
        text += `🏆 Опыт автомеханика: +${expReward}\n\n`;

        if (levelUp) {
            text += `⭐ ПОВЫШЕНИЕ УРОВНЯ!\n`;
            text += `🔩 Уровень автомеханика: ${user.mechanic_level}\n`;
            text += `💪 Теперь вы можете выполнять более сложные и дорогие работы!\n\n`;
        }

        text += `🎯 Хотите начать новую работу?`;

        const keyboard = Utils.createKeyboard([
            [
                { label: "🔍 Новая работа", payload: { cmd: 'start_job' } }
            ],
            [
                { label: "🔩 Автомеханик", payload: { cmd: 'auto_mechanic' } },
                { label: "🏠 Меню", payload: { cmd: 'menu' } }
            ]
        ], true);

        await context.send({
            message: text,
            keyboard: keyboard
        });
    }

    static async createRace(context) {
        const chatId = context.peerId.toString();

        if (localRaces.has(chatId)) {
            await context.send("❌ В этом чате уже есть активная гонка!");
            return;
        }

        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        if (!user.cars || Object.keys(user.cars).length === 0) {
            await context.send("❌ У вас нет машин! Сначала купите машину.");
            return;
        }

        // Получаем активную машину
        let activeCarId = user.active_car;
        const cars = user.cars;

        if (!activeCarId || !cars[activeCarId]) {
            activeCarId = Object.keys(cars)[0];
            user.active_car = activeCarId;
            Utils.saveData('users.json', usersData);
        }

        const carData = cars[activeCarId];

        // Создаем гонку
        const raceId = `local_${chatId}_${Math.floor(Date.now() / 1000)}`;
        const race = new Race(raceId, chatId, context.senderId, false);

        // Добавляем создателя
        race.addPlayer(context.senderId, user.username, carData);
        localRaces.set(chatId, race);

        // Отправляем сообщение с inline кнопками
        const raceText = race.getRaceInfo();
        const keyboard = Utils.createKeyboard([
            [
                { label: "✅ Присоединиться", payload: { cmd: 'join_race' } }
            ],
            [
                { label: "🏁 Начать гонку", payload: { cmd: 'start_race' } },
                { label: "❌ Выйти", payload: { cmd: 'leave_race' } }
            ]
        ], true);

        await context.send({
            message: raceText,
            keyboard: keyboard
        });
    }

    static async joinRace(context) {
        const chatId = context.peerId.toString();
        const race = localRaces.get(chatId);

        if (!race) {
            await context.send("❌ В этом чате нет активной гонки!");
            return;
        }

        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        if (!user.cars || Object.keys(user.cars).length === 0) {
            await context.send("❌ У вас нет машин!");
            return;
        }

        // Получаем активную машину
        let activeCarId = user.active_car;
        const cars = user.cars;

        if (!activeCarId || !cars[activeCarId]) {
            activeCarId = Object.keys(cars)[0];
        }

        const carData = cars[activeCarId];
        const result = race.addPlayer(context.senderId, user.username, carData);

        if (result.success) {
            await context.send(`✅ ${user.username} присоединился к гонке!`);
            
            // Обновляем сообщение гонки
            const raceText = race.getRaceInfo();
            const keyboard = Utils.createKeyboard([
                [
                    { label: "✅ Присоединиться", payload: { cmd: 'join_race' } }
                ],
                [
                    { label: "🏁 Начать гонку", payload: { cmd: 'start_race' } },
                    { label: "❌ Выйти", payload: { cmd: 'leave_race' } }
                ]
            ], true);

            await context.send({
                message: raceText,
                keyboard: keyboard
            });
        } else {
            await context.send(`❌ ${result.message}`);
        }
    }

    static async leaveRace(context) {
        const chatId = context.peerId.toString();
        const race = localRaces.get(chatId);

        if (!race) {
            await context.send("❌ В этом чате нет активной гонка!");
            return;
        }

        if (!race.players.has(context.senderId)) {
            await context.send("❌ Вы не участвуете в этой гонке!");
            return;
        }

        const playerName = race.players.get(context.senderId).userName;
        race.removePlayer(context.senderId);

        // Если гонка пустая, удаляем её
        if (race.players.size === 0) {
            localRaces.delete(chatId);
            await context.send("✅ Гонка удалена, так как в ней не осталось участников.");
        } else {
            const raceText = race.getRaceInfo();
            const keyboard = Utils.createKeyboard([
                [
                    { label: "✅ Присоединиться", payload: { cmd: 'join_race' } }
                ],
                [
                    { label: "🏁 Начать гонку", payload: { cmd: 'start_race' } },
                    { label: "❌ Выйти", payload: { cmd: 'leave_race' } }
                ]
            ], true);
            
            await context.send(`✅ ${playerName} вышел из гонки`);
            await context.send({
                message: raceText,
                keyboard: keyboard
            });
        }
    }

    static async startRace(context) {
        const chatId = context.peerId.toString();
        const race = localRaces.get(chatId);

        if (!race) {
            await context.send("❌ В этом чате нет активной гонка!");
            return;
        }

        const result = race.startRace(context.senderId);

        if (result.success) {
            await context.send("🏁 ГОНКА НАЧАЛАСЬ! 🏁");

            // Запускаем обновление гонки
            this.runRaceUpdates(context, race);
        } else {
            await context.send(`❌ ${result.message}`);
        }
    }

    static async runRaceUpdates(context, race) {
        const chatId = race.chatId;
        const startTime = Date.now();
        let lastUpdateTime = startTime;

        while (race.status === "in_progress" && localRaces.has(chatId) && (Date.now() - startTime) < 60000) {
            const raceUpdated = race.updateRace();

            // Отправляем обновление каждые 5 секунд или при завершении
            const currentTime = Date.now();
            if (raceUpdated || (currentTime - lastUpdateTime) >= 5000) {
                const raceText = race.getRaceInfo();
                await context.send(raceText);
                lastUpdateTime = currentTime;
            }

            if (raceUpdated) break;

            await new Promise(resolve => setTimeout(resolve, CONFIG.UPDATE_INTERVAL * 1000));
        }

        // Гонка завершена
        if (race.status === "finished" && localRaces.has(chatId)) {
            this.awardPlayers(race);
            const resultsText = race.getRaceInfo();
            await context.send(resultsText);

            // Удаляем гонку через 10 секунд
            setTimeout(() => {
                localRaces.delete(chatId);
            }, 10000);
        }
    }

    static awardPlayers(race) {
        const usersData = Utils.loadData('users.json');

        for (const [userId, player] of race.players) {
            const userIdStr = userId.toString();
            const user = usersData.users?.[userIdStr];
            
            if (!user) continue;

            // Награды в зависимости от позиции
            let reward, exp;
            if (player.position === 1) {
                reward = 1000;
                exp = 50;
            } else if (player.position === 2) {
                reward = 600;
                exp = 30;
            } else if (player.position === 3) {
                reward = 300;
                exp = 20;
            } else {
                reward = 100;
                exp = 10;
            }

            user.money += reward;
            user.exp += exp;

            // Проверка повышения уровня
            let levelsGained = 0;
            while (user.exp >= 100) {
                user.level += 1;
                user.exp -= 100;
                user.money += CONFIG.LEVEL_REWARD;
                levelsGained += 1;
            }
        }

        Utils.saveData('users.json', usersData);
    }

    static async showRaces(context) {
        if (context.peerId === context.senderId) {
            await this.showGlobalRaces(context);
            return;
        }

        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ У вас нет аккаунта в боте! Напишите 'Начать' для регистрации.");
            return;
        }

        if (!user.cars || Object.keys(user.cars).length === 0) {
            await context.send("❌ У вас нет машин! Сначала купите машину в автосалоне.");
            return;
        }

        const chatId = context.peerId.toString();

        if (localRaces.has(chatId)) {
            await this.showRaceStatus(context);
        } else {
            await this.createRaceMenu(context);
        }
    }

    static async createRaceMenu(context) {
        let text = "🏎️ ГОНКИ!\n\n";
        text += "Вы можете создать гонку в этом чате.\n";
        text += `📍 Дистанция: ${Utils.formatNumber(CONFIG.RACE_DISTANCE)}м\n`;
        text += `👥 Максимум игроков: ${CONFIG.MAX_PLAYERS} (с Premium: ${CONFIG.MAX_PREMIUM_PLAYERS})\n`;
        text += `🎯 Минимум для старта: ${CONFIG.MIN_PLAYERS}\n\n`;
        text += " - Выберите действие:";

        // INLINE кнопка для создания гонки
        const keyboard = Utils.createKeyboard([
            [
                { label: "➕ Создать гонку", payload: { cmd: 'create_race' } }
            ]
        ], true);

        await context.send({
            message: text,
            keyboard: keyboard
        });
    }

    static async showRaceStatus(context) {
        const chatId = context.peerId.toString();
        const race = localRaces.get(chatId);

        if (!race) {
            await context.send("❌ В этом чате нет активной гонка!");
            return;
        }

        const raceText = race.getRaceInfo();
        let keyboardButtons = [];

        if (race.status === "waiting") {
            keyboardButtons = [
                [
                    { label: "✅ Присоединиться", payload: { cmd: 'join_race' } }
                ]
            ];
            if (context.senderId === race.creatorId) {
                keyboardButtons[0].push({ label: "🏁 Начать гонку", payload: { cmd: 'start_race' } });
            }
            keyboardButtons.push([
                { label: "❌ Выйти", payload: { cmd: 'leave_race' } }
            ]);
        } else if (race.status === "in_progress") {
            keyboardButtons = [
                [
                    { label: "🔄 Обновить", payload: { cmd: 'race_status' } }
                ]
            ];
        } else {
            keyboardButtons = [
                [
                    { label: "🏎️ Новая гонку", payload: { cmd: 'create_race' } }
                ]
            ];
        }

        const keyboard = Utils.createKeyboard(keyboardButtons, true);

        await context.send({
            message: raceText,
            keyboard: keyboard
        });
    }

    static async handleDragRace(context) {
        const text = context.text.toLowerCase();
        const parts = text.split(' ');

        if (parts.length < 2) {
            await context.send("❌ Использование: драг [упоминание/@id]");
            return;
        }

        const targetText = parts[1];
        const targetId = Utils.extractUserId(targetText);

        if (!targetId) {
            await context.send("❌ Не удалось определить пользователя! Укажите упоминание или ссылку.");
            return;
        }

        if (targetId === context.senderId) {
            await context.send("❌ Нельзя устраивать драг с самим собой!");
            return;
        }

        const usersData = Utils.loadData('users.json');
        const userIdStr = context.senderId.toString();
        const targetIdStr = targetId.toString();

        if (!usersData.users?.[userIdStr]) {
            await context.send("❌ Сначала зарегистрируйтесь в боте!");
            return;
        }

        if (!usersData.users?.[targetIdStr]) {
            await context.send("❌ Этот пользователь не зарегистрирован в боте!");
            return;
        }

        const user = usersData.users[userIdStr];
        const targetUser = usersData.users[targetIdStr];

        if (!user.cars || !targetUser.cars) {
            await context.send("❌ У кого-то из игроков нет машин!");
            return;
        }

        // Создаем драг-рейсинг
        const dragId = `drag_${context.peerId}_${Date.now()}`;
        
        const dragRace = {
            player1Id: context.senderId,
            player2Id: targetId,
            chatId: context.peerId,
            status: "waiting",
            players: new Map(),
            distance: 400
        };

        // Добавляем игроков
        const userCar = user.cars[user.active_car] || Object.values(user.cars)[0];
        const targetCar = targetUser.cars[targetUser.active_car] || Object.values(targetUser.cars)[0];

        dragRace.players.set(context.senderId, {
            userName: user.username,
            car: userCar,
            progress: 0,
            finished: false,
            finishTime: null
        });

        dragRace.players.set(targetId, {
            userName: targetUser.username,
            car: targetCar,
            progress: 0,
            finished: false,
            finishTime: null
        });

        dragRaces.set(dragId, dragRace);

        // Отправляем сообщение о вызове
        const challengeText = `🔥 ВЫЗОВ НА ДРАГ-РЕЙСИНГ! 🔥\n\n` +
            `${user.username} вызывает ${targetUser.username} на гонку!\n` +
            `📍 Дистанция: 400м\n\n` +
            `Готовы ли вы принять вызов?`;

        const keyboard = Utils.createKeyboard([
            [
                { label: "✅ Принять вызов", payload: { cmd: 'accept_drag', drag_id: dragId } },
                { label: "❌ Отклонить", payload: { cmd: 'decline_drag', drag_id: dragId } }
            ]
        ], true);

        await context.send({
            message: challengeText,
            keyboard: keyboard
        });
    }

    static async acceptDragRace(context, dragId) {
        if (!dragRaces.has(dragId)) {
            await context.send("❌ Вызов не найден или устарел!");
            return;
        }

        const dragRace = dragRaces.get(dragId);

        if (context.senderId !== dragRace.player2Id) {
            await context.send("❌ Этот вызов не для вас!");
            return;
        }

        // Начинаем драг-рейсинг
        dragRace.status = "in_progress";
        dragRace.startTime = Date.now() / 1000;

        await context.send("🎯 ВЫЗОВ ПРИНЯТ! ДРАГ-РЕЙСИНГ НАЧИНАЕТСЯ! 🎯");

        // Запускаем драг в отдельном потоке
        this.runDragRace(context, dragRace, dragId);
    }

    static async runDragRace(context, dragRace, dragId) {
        const startTime = Date.now();
        let lastUpdateTime = startTime;

        while (dragRace.status === "in_progress" && (Date.now() - startTime) < 15000) {
            const finished = this.updateDragRace(dragRace);

            // Отправляем обновление только раз в 10 секунд или при финише
            const currentTime = Date.now();
            if (finished || (currentTime - lastUpdateTime) >= 10000) {
                const raceText = this.getDragRaceInfo(dragRace);
                await context.send(raceText);
                lastUpdateTime = currentTime;
            }

            if (finished) break;

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Завершаем драг
        if (dragRace.status === "in_progress") {
            dragRace.status = "finished";
        }

        // Определяем победителя
        let winnerId = this.getDragRaceWinner(dragRace);
        if (!winnerId) {
            // Если нет победителя по времени, выбираем по прогрессу
            let maxProgress = 0;
            for (const [userId, player] of dragRace.players) {
                if (player.progress > maxProgress) {
                    maxProgress = player.progress;
                    winnerId = userId;
                }
            }
        }

        if (winnerId) {
            const winnerName = dragRace.players.get(winnerId).userName;
            await context.send(`🏆 ПОБЕДИТЕЛЬ: ${winnerName}!`);

            // Награждаем победителя
            const usersData = Utils.loadData('users.json');
            const winnerIdStr = winnerId.toString();
            
            if (usersData.users?.[winnerIdStr]) {
                const user = usersData.users[winnerIdStr];
                user.money += 500;
                user.exp += 25;
                Utils.saveData('users.json', usersData);
            }
        }

        // Удаляем драг из активных
        dragRaces.delete(dragId);
    }

    static updateDragRace(dragRace) {
        let raceFinished = true;

        for (const [userId, player] of dragRace.players) {
            if (player.finished) continue;

            const speed = this.calculateDragSpeed(player);
            player.progress += speed;

            if (player.progress >= dragRace.distance) {
                player.finished = true;
                player.progress = dragRace.distance;
                player.finishTime = (Date.now() / 1000) - dragRace.startTime;
            } else {
                raceFinished = false;
            }
        }

        return raceFinished;
    }

    static calculateDragSpeed(playerData) {
        const car = playerData.car;
        const baseSpeed = car.hp * 0.03;
        const speedBoost = car.max_speed * 0.01;
        const conditionEffect = (car.tire_health * (car.durability || 100)) / 10000;
        const randomFactor = 0.95 + Math.random() * 0.1;

        return (baseSpeed + speedBoost) * conditionEffect * randomFactor;
    }

    static getDragRaceWinner(dragRace) {
        const times = new Map();
        for (const [userId, player] of dragRace.players) {
            if (player.finished) {
                times.set(userId, player.finishTime);
            }
        }

        if (times.size === 2) {
            let minTime = Infinity;
            let winnerId = null;
            
            for (const [userId, time] of times) {
                if (time < minTime) {
                    minTime = time;
                    winnerId = userId;
                }
            }
            return winnerId;
        }
        return null;
    }

    static getDragRaceInfo(dragRace) {
        let text = "🔥 ДРАГ-РЕЙСИНГ!\n\n";
        text += "📍 Дистанция: 400м\n\n";

        for (const [userId, player] of dragRace.players) {
            const progressPercent = Math.min(100, Math.floor(player.progress / dragRace.distance * 100));
            const trackLength = 20;
            const carPosition = Math.min(trackLength - 1, Math.floor((player.progress / dragRace.distance) * trackLength));
            let trackVisual = "─".repeat(trackLength);
            
            if (carPosition < trackLength) {
                trackVisual = trackVisual.substring(0, carPosition) + "🚗" + trackVisual.substring(carPosition + 1);
            }

            const status = player.finished ? 
                `🏁 ФИНИШ! (${player.finishTime.toFixed(2)}с)` : 
                `${progressPercent}%`;

            text += `${player.userName}\n${trackVisual}\n${status}\n\n`;
        }

        return text;
    }

    static async handlePvpCommand(context) {
        if (context.peerId === context.senderId) {
            await this.startPvpRace(context);
        } else {
            await context.send("❌ 1х1 гонки доступны только в личных сообщениях с ботом!");
        }
    }

    static async startPvpRace(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь в боте!");
            return;
        }

        if (!user.cars || Object.keys(user.cars).length === 0) {
            await context.send("❌ У вас нет машин! Сначала купите машину.");
            return;
        }

        // Проверяем, не ищет ли уже пользователь гонку
        if (pvpWaitingPlayers.has(context.senderId)) {
            await context.send("🔍 Вы уже ищете противника...");
            return;
        }

        // Получаем активную машину
        let activeCarId = user.active_car;
        const cars = user.cars;

        if (!activeCarId || !cars[activeCarId]) {
            activeCarId = Object.keys(cars)[0];
        }

        const carData = cars[activeCarId];

        // Добавляем в очередь ожидания
        pvpWaitingPlayers.set(context.senderId, {
            user_name: user.username,
            car_data: carData,
            search_start_time: Date.now(),
            context: context
        });

        await context.send("🔍 Ищем противника для 1х1 гонки...");

        // Запускаем поиск противника
        setTimeout(() => this.findPvpOpponent(context.senderId), 1000);
    }

    static async findPvpOpponent(playerId) {
        const maxWaitTime = 30000;
        const startTime = Date.now();

        const checkInterval = setInterval(() => {
            if (Date.now() - startTime > maxWaitTime) {
                // Время вышло
                if (pvpWaitingPlayers.has(playerId)) {
                    const playerData = pvpWaitingPlayers.get(playerId);
                    pvpWaitingPlayers.delete(playerId);
                    if (playerData?.context) {
                        playerData.context.send("❌ Не удалось найти противника. Попробуйте позже!");
                    }
                }
                clearInterval(checkInterval);
                return;
            }

            // Ищем случайного противника
            const waitingPlayers = Array.from(pvpWaitingPlayers.keys());
            const potentialOpponents = waitingPlayers.filter(p => p !== playerId);

            if (potentialOpponents.length > 0) {
                const opponentId = potentialOpponents[Math.floor(Math.random() * potentialOpponents.length)];
                
                // Создаем гонку
                const raceId = `pvp_${playerId}_${opponentId}_${Date.now()}`;
                
                const playerData = pvpWaitingPlayers.get(playerId);
                const opponentData = pvpWaitingPlayers.get(opponentId);

                // Удаляем из ожидания
                pvpWaitingPlayers.delete(playerId);
                pvpWaitingPlayers.delete(opponentId);

                // Создаем PvP гонку
                const pvpRace = {
                    raceId: raceId,
                    player1Id: playerId,
                    player2Id: opponentId,
                    status: "waiting",
                    players: new Map(),
                    distance: 1000,
                    startTime: null
                };

                pvpRace.players.set(playerId, {
                    user_name: playerData.user_name,
                    car: playerData.car_data,
                    progress: 0,
                    finished: false,
                    car_name: playerData.car_data.name,
                    finishTime: null
                });

                pvpRace.players.set(opponentId, {
                    user_name: opponentData.user_name,
                    car: opponentData.car_data,
                    progress: 0,
                    finished: false,
                    car_name: opponentData.car_data.name,
                    finishTime: null
                });

                pvpActiveRaces.set(raceId, pvpRace);

                // Уведомляем игроков
                this.notifyPvpPlayersStart(pvpRace);

                // Запускаем гонку
                this.runPvpRace(raceId);

                clearInterval(checkInterval);
            }
        }, 2000);
    }

    static async notifyPvpPlayersStart(pvpRace) {
        const player1 = pvpRace.players.get(pvpRace.player1Id);
        const player2 = pvpRace.players.get(pvpRace.player2Id);

        const message = `🏁 1х1 ГОНКА НАЧАЛАСЬ! 🏁\n\n` +
                       `${player1.user_name} vs ${player2.user_name}\n` +
                       `🚗 ${player1.car_name} vs ${player2.car_name}`;

        try {
            await vk.api.messages.send({
                user_id: pvpRace.player1Id,
                message: message,
                random_id: Math.floor(Math.random() * 1000000)
            });

            await vk.api.messages.send({
                user_id: pvpRace.player2Id,
                message: message,
                random_id: Math.floor(Math.random() * 1000000)
            });
        } catch (error) {
            console.error('Error sending PvP notification:', error);
        }
    }

    static async runPvpRace(raceId) {
        const pvpRace = pvpActiveRaces.get(raceId);
        if (!pvpRace) return;

        pvpRace.status = "in_progress";
        pvpRace.startTime = Date.now() / 1000;

        const startTime = Date.now();
        let lastUpdateTime = startTime;

        const interval = setInterval(() => {
            if (!pvpActiveRaces.has(raceId)) {
                clearInterval(interval);
                return;
            }

            const raceFinished = this.updatePvpRace(pvpRace);

            // Отправляем обновление каждые 3 секунды или при завершении
            const currentTime = Date.now();
            if (raceFinished || currentTime - lastUpdateTime >= 3000) {
                const progressText = this.getPvpRaceProgress(pvpRace);
                this.sendPvpProgress(pvpRace, progressText);
                lastUpdateTime = currentTime;
            }

            if (raceFinished) {
                clearInterval(interval);
                this.finishPvpRace(pvpRace);
            }

            if (Date.now() - startTime > 60000) {
                clearInterval(interval);
                pvpRace.status = "finished";
                this.finishPvpRace(pvpRace);
            }
        }, 1000);
    }

    static updatePvpRace(pvpRace) {
        let raceFinished = true;

        for (const [userId, player] of pvpRace.players) {
            if (player.finished) continue;

            const speed = this.calculatePvpSpeed(player);
            player.progress += speed;

            if (player.progress >= pvpRace.distance) {
                player.finished = true;
                player.finishTime = (Date.now() / 1000) - pvpRace.startTime;
            } else {
                raceFinished = false;
            }
        }

        return raceFinished;
    }

    static calculatePvpSpeed(playerData) {
        const car = playerData.car;
        const baseSpeed = car.max_speed * 0.25 + car.hp * 0.15;
        const conditionMultiplier = (car.tire_health * 0.7 + (car.durability || 100) * 0.3) / 100;
        const randomFactor = 0.95 + Math.random() * 0.1;

        return baseSpeed * conditionMultiplier * randomFactor;
    }

    static getPvpRaceProgress(pvpRace) {
        const player1 = pvpRace.players.get(pvpRace.player1Id);
        const player2 = pvpRace.players.get(pvpRace.player2Id);

        const trackLength = 20;
        const p1Pos = Math.min(trackLength - 1, Math.floor((player1.progress / pvpRace.distance) * trackLength));
        const p2Pos = Math.min(trackLength - 1, Math.floor((player2.progress / pvpRace.distance) * trackLength));

        let trackP1 = "─".repeat(trackLength);
        let trackP2 = "─".repeat(trackLength);

        if (p1Pos < trackLength) {
            trackP1 = trackP1.substring(0, p1Pos) + "🚗" + trackP1.substring(p1Pos + 1);
        }
        if (p2Pos < trackLength) {
            trackP2 = trackP2.substring(0, p2Pos) + "🚗" + trackP2.substring(p2Pos + 1);
        }

        let text = "🏁 1х1 ГОНКА 🏁\n\n";
        text += `${player1.user_name}\n${trackP1} ${Math.floor(player1.progress)}m\n\n`;
        text += `${player2.user_name}\n${trackP2} ${Math.floor(player2.progress)}m\n\n`;

        if (pvpRace.status === "finished") {
            const winner = this.getPvpRaceWinner(pvpRace);
            if (winner) {
                text += `🏆 ПОБЕДИТЕЛЬ: ${winner.user_name}!`;
            }
        }

        return text;
    }

    static async sendPvpProgress(pvpRace, text) {
        try {
            await vk.api.messages.send({
                user_id: pvpRace.player1Id,
                message: text,
                random_id: Math.floor(Math.random() * 1000000)
            });

            await vk.api.messages.send({
                user_id: pvpRace.player2Id,
                message: text,
                random_id: Math.floor(Math.random() * 1000000)
            });
        } catch (error) {
            console.error('Error sending PvP progress:', error);
        }
    }

    static getPvpRaceWinner(pvpRace) {
        let winnerId = null;
        let minTime = Infinity;

        for (const [userId, player] of pvpRace.players) {
            if (player.finished && player.finishTime < minTime) {
                minTime = player.finishTime;
                winnerId = userId;
            }
        }

        return winnerId ? pvpRace.players.get(winnerId) : null;
    }

    static finishPvpRace(pvpRace) {
        const winner = this.getPvpRaceWinner(pvpRace);
        if (winner) {
            this.awardPvpPlayers(pvpRace, winner.userId || pvpRace.player1Id);
            
            // Уведомляем игроков
            const message = `🏁 1х1 ГОНКА ЗАВЕРШЕНА! 🏁\n\n🏆 ПОБЕДИТЕЛЬ: ${winner.user_name}`;
            
            vk.api.messages.send({
                user_id: pvpRace.player1Id,
                message: message,
                random_id: Math.floor(Math.random() * 1000000)
            }).catch(console.error);

            vk.api.messages.send({
                user_id: pvpRace.player2Id,
                message: message,
                random_id: Math.floor(Math.random() * 1000000)
            }).catch(console.error);
        }

        pvpActiveRaces.delete(pvpRace.raceId);
    }

    static awardPvpPlayers(pvpRace, winnerId) {
        const usersData = Utils.loadData('users.json');

        // Награда победителю
        const winnerIdStr = winnerId.toString();
        if (usersData.users?.[winnerIdStr]) {
            const winner = usersData.users[winnerIdStr];
            winner.money += 800;
            winner.exp += 40;

            // Проверка повышения уровня
            while (winner.exp >= 100) {
                winner.level += 1;
                winner.exp -= 100;
                winner.money += CONFIG.LEVEL_REWARD;
            }
        }

        // Награда проигравшему
        const loserId = winnerId === pvpRace.player1Id ? pvpRace.player2Id : pvpRace.player1Id;
        const loserIdStr = loserId.toString();
        
        if (usersData.users?.[loserIdStr]) {
            const loser = usersData.users[loserIdStr];
            loser.money += 300;
            loser.exp += 15;
            
            // Проверка повышения уровня
            while (loser.exp >= 100) {
                loser.level += 1;
                loser.exp -= 100;
                loser.money += CONFIG.LEVEL_REWARD;
            }
        }

        Utils.saveData('users.json', usersData);
    }

    static async showGlobalRaces(context) {
        let text = "🌍 ГЛОБАЛЬНЫЕ ГОНКИ\n\n";
        text += `📍 Дистанция: ${Utils.formatNumber(CONFIG.GLOBAL_RACE_DISTANCE)}м\n`;
        text += `⏰ Время ожидания: 15 минут\n`;
        text += `👥 Минимум игроков: ${CONFIG.MIN_PLAYERS}\n`;
        text += `💰 Награды в 2 раза выше!\n\n`;
        text += "Присоединяйтесь к гонке и соревнуйтесь с игроками со всей сети!";

        const keyboard = Utils.createKeyboard([
            [
                { label: "🎮 Найти гонку", payload: { cmd: 'find_global_race' } }
            ],
            [
                { label: "📊 Мои результаты", payload: { cmd: 'my_results' } }
            ],
            [
                { label: "🏠 Меню", payload: { cmd: 'menu' } }
            ]
        ], true);

        await context.send({
            message: text,
            keyboard: keyboard
        });
    }

    static async findGlobalRace(context) {
        await context.send("🌍 Система глобальных гонок находится в разработке. Скоро будет доступна!");
    }

    static async myResults(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();
        const user = usersData.users?.[userId];

        if (!user) {
            await context.send("❌ Сначала зарегистрируйтесь!");
            return;
        }

        let text = `📊 СТАТИСТИКА ИГРОКА\n\n`;
        text += `👤 ${user.username}\n`;
        text += `💰 Баланс: ${Utils.formatNumber(user.money)} руб.\n`;
        text += `⭐ Уровень: ${user.level}\n`;
        text += `📈 Опыт: ${user.exp}/100\n`;
        text += `🚗 Машин в гараже: ${user.cars ? Object.keys(user.cars).length : 0}\n\n`;

        text += "🏆 Статистика:\n";
        text += "• Побед: в разработке\n";
        text += "• Участий: в разработке\n";

        await context.send(text);
    }

    static async showCommands(context) {
        const usersData = Utils.loadData('users.json');
        const userId = context.senderId.toString();

        if (!usersData.users?.[userId]) {
            await context.send("❌ У вас нет аккаунта в боте! Напишите 'Начать' для регистрации.");
            return;
        }

        const userInfo = await Utils.getUserInfo(context.senderId);
        
        let text = `📚 Привет, ${userInfo.first_name}, вот все команды бота:\n\n`;
        text += `🏎️ ОСНОВНЫЕ КОМАНДЫ:\n`;
        text += `- Меню - главное меню бота\n`;
        text += `- Помощь - показать команды\n`;
        text += `- Гонка - меню гонок\n`;
        text += `- Поддержка - поддержка бота\n\n`;

        text += `🚗 АВТОМОБИЛИ:\n`;
        text += `- Гараж - ваши машины\n`;
        text += `- Автосалон - купить машину\n`;
        text += `- Техцентр - улучшить машину\n`;
        text += `- Автомеханик - тюнинг машины\n\n`;

        text += `🎮 В ЛИЧКЕ:\n`;
        text += `- 1х1 или PvP - найти соперника для 1х1 гонки\n`;
        text += `- Глобальные гонки - соревнования со всеми\n\n`;

        text += `🎮 В ЧАТАХ:\n`;
        text += `- Гонка - создать/присоединиться к гонке\n`;
        text += `- Старт - начать гонку\n`;
        text += `- Драг [@игрок] - вызвать на драг-рейсинг\n\n`;

        text += `🙂 Команды будут добавляться, следите за новостями!`;
        
        await context.send(text);
    }

    static async handleAdminCommand(context) {
        const adminData = Utils.loadData('admin.json');
        const userId = context.senderId.toString();
        
        if (!adminData.moders?.users_ids?.includes(userId)) {
            return;
        }

        const text = context.text.toLowerCase();
        const parts = text.split(' ');

        if (parts.length < 2) {
            await this.showAdminPanel(context);
            return;
        }

        const command = parts[1];

        switch (command) {
            case 'premium':
                if (parts.length >= 3) {
                    await this.adminAddPremium(context, parts[2]);
                }
                break;
            case 'money':
                if (parts.length >= 4) {
                    await this.adminAddMoney(context, parts[2], parts[3]);
                }
                break;
            case 'cars':
                await this.showAllCars(context);
                break;
            case 'stats':
                await this.showBotStats(context);
                break;
            case 'обнул':
                if (parts.length >= 3) {
                    await this.resetUser(context, parts[2]);
                }
                break;
            case 'ban':
                if (parts.length >= 5) {
                    await this.adminBanUser(context, parts[2], parts[3], parts.slice(4).join(' '));
                }
                break;
            case 'unban':
                if (parts.length >= 3) {
                    await this.adminUnbanUser(context, parts[2]);
                }
                break;
            case 'checkban':
                if (parts.length >= 3) {
                    await this.adminCheckBan(context, parts[2]);
                }
                break;
            default:
                await this.showAdminPanel(context);
        }
    }

    static async showAdminPanel(context) {
        let text = "⚙️ ПАНЕЛЬ АДМИНИСТРАТОРА\n\n";
        text += "Доступные команды:\n";
        text += "/admin premium [chat_id] - выдать Premium\n";
        text += "/admin money [user_id] [amount] - выдать деньги\n";
        text += "/admin cars - список всех машин\n";
        text += "/admin stats - статистика бота\n";
        text += "/admin ban [user_id] [дни] [причина]\n";
        text += "/admin checkban [user_id]\n";
        text += "/admin unban [user_id]\n";
        text += "/admin обнул [user_id]";

        await context.send(text);
    }

    static async adminAddPremium(context, chatId) {
        const chatsData = Utils.loadData('chats.json');
        
        if (!chatsData.chats?.[chatId]) {
            await context.send("⚠️ Этого чата нет в базе данных!");
            return;
        }

        const chat = chatsData.chats[chatId];
        if (chat.premium !== false) {
            await context.send("⚠️ У этого чата уже есть Premium");
            return;
        }

        chat.premium = true;
        Utils.saveData('chats.json', chatsData);
        await context.send("✅ Успешно!");
    }

    static async adminAddMoney(context, userInput, amountStr) {
        try {
            const amount = parseInt(amountStr);

            if (amount <= 0) {
                await context.send("❌ Сумма должна быть положительной!");
                return;
            }

            if (amount > 1000000) {
                await context.send("❌ Слишком большая сумма! Максимум 1.000.000 руб.");
                return;
            }

            const usersData = Utils.loadData('users.json');
            const users = usersData.users || {};

            // Функция поиска пользователя
            let userData = null;
            let userId = null;

            // Пробуем как числовой ID
            if (userInput.match(/^\d+$/)) {
                userId = userInput;
                userData = users[userId];
            }

            // Пробуем как упоминание
            if (!userData) {
                const extractedId = Utils.extractUserId(userInput);
                if (extractedId) {
                    userId = extractedId.toString();
                    userData = users[userId];
                }
            }

            // Пробуем найти по имени
            if (!userData) {
                for (const [uid, data] of Object.entries(users)) {
                    if (data.username?.toLowerCase() === userInput.toLowerCase()) {
                        userData = data;
                        userId = uid;
                        break;
                    }
                }
            }

            if (!userData) {
                await context.send("❌ Пользователь не найден! Укажите:\n• Упоминание (@user)\n• ID пользователя\n• Точное имя");
                return;
            }

            // Выдаем деньги
            const oldBalance = userData.money;
            userData.money += amount;
            Utils.saveData('users.json', usersData);

            await context.send(
                `✅ Деньги выданы успешно!\n\n` +
                `👤 Получатель: ${userData.username}\n` +
                `💰 Сумма: ${Utils.formatNumber(amount)} руб.\n` +
                `📊 Баланс: ${Utils.formatNumber(oldBalance)} → ${Utils.formatNumber(userData.money)} руб.\n` +
                `🆔 ID: ${userId}`
            );

        } catch (error) {
            await context.send(`❌ Ошибка при выдаче денег: ${error.message}`);
        }
    }

    static async showAllCars(context) {
        const carsData = Utils.loadData('cars.json');
        let text = "🚗 ВСЕ МАШИНЫ В МАГАЗИНЕ:\n\n";
        
        for (const [carId, car] of Object.entries(carsData.cars_shop || {})) {
            text += `${carId}. ${car.name} - ${car.price} руб.\n`;
        }

        await context.send(text);
    }

    static async showBotStats(context) {
        const usersData = Utils.loadData('users.json');
        const chatsData = Utils.loadData('chats.json');

        let text = "📊 СТАТИСТИКА БОТА:\n\n";
        text += `👤 Пользователей: ${Object.keys(usersData.users || {}).length}\n`;
        text += `💬 Чатов: ${Object.keys(chatsData.chats || {}).length}\n`;
        text += `🏎️ Активных гонок: ${localRaces.size}\n`;
        text += `🌍 Глобальных гонок: 0\n`;

        await context.send(text);
    }

    static async resetUser(context, userInput) {
        const usersData = Utils.loadData('users.json');
        let userId = null;

        // Пробуем извлечь ID
        if (userInput.match(/^\d+$/)) {
            userId = userInput;
        } else {
            userId = Utils.extractUserId(userInput)?.toString();
        }

        if (!userId || !usersData.users?.[userId]) {
            await context.send("Этого юзера нет в базе данных!");
            return;
        }

        const user = usersData.users[userId];
        user.money = 0;
        user.exp = 0;
        user.level = 0;
        user.pistons = 0;
        user.cars = {};
        user.mechanic_level = 1;
        user.mechanic_exp = 0;
        Utils.saveData('users.json', usersData);

        await context.send(`[id${userId}|Пользователь] успешно обнулён!`);
    }

    static async adminBanUser(context, userInput, daysStr, reason) {
        try {
            const days = parseInt(daysStr);
            
            if (days <= 0) {
                await context.send("❌ Количество дней должно быть положительным числом!");
                return;
            }

            const adminData = Utils.loadData('admin.json');
            let userId = null;

            // Извлекаем ID пользователя
            if (userInput.match(/^\d+$/)) {
                userId = userInput;
            } else {
                userId = Utils.extractUserId(userInput)?.toString();
            }

            if (!userId) {
                await context.send("❌ Не удалось определить пользователя!");
                return;
            }

            // Инициализируем структуру бана если её нет
            if (!adminData.ban) {
                adminData.ban = { users_ids: [] };
            }

            const currentTime = Math.floor(Date.now() / 1000);

            // Проверяем, забанен ли уже
            if (adminData.ban.users_ids?.includes(userId)) {
                // Удаляем старый бан
                adminData.ban.users_ids = adminData.ban.users_ids.filter(id => id !== userId);
                if (adminData.ban[userId]) {
                    delete adminData.ban[userId];
                }
            }

            // Создаем новый бан
            adminData.ban[userId] = {
                days: days,
                time: currentTime,
                reason: reason
            };

            if (!adminData.ban.users_ids.includes(userId)) {
                adminData.ban.users_ids.push(userId);
            }

            Utils.saveData('admin.json', adminData);

            const endTime = currentTime + (days * 24 * 60 * 60);
            const endDate = new Date(endTime * 1000).toLocaleString('ru-RU');

            await context.send(
                `✅ [id${userId}|Пользователь] успешно заблокирован!\n\n` +
                `📊 Информация о бане:\n` +
                `• До: ${endDate}\n` +
                `• Срок: ${days} дней\n` +
                `• Причина: ${reason}\n\n` +
                `⏰ Бан истечет через ${days} дней`
            );

        } catch (error) {
            await context.send(`❌ Ошибка при бане пользователя: ${error.message}`);
        }
    }

    static async adminUnbanUser(context, userInput) {
        try {
            const adminData = Utils.loadData('admin.json');
            let userId = null;

            if (userInput.match(/^\d+$/)) {
                userId = userInput;
            } else {
                userId = Utils.extractUserId(userInput)?.toString();
            }

            if (!userId) {
                await context.send("❌ Не удалось определить пользователя!");
                return;
            }

            if (!adminData.ban?.users_ids?.includes(userId)) {
                await context.send("❌ Пользователь не забанен!");
                return;
            }

            // Удаляем пользователя из бана
            adminData.ban.users_ids = adminData.ban.users_ids.filter(id => id !== userId);
            if (adminData.ban[userId]) {
                delete adminData.ban[userId];
            }

            Utils.saveData('admin.json', adminData);

            await context.send(`✅ [id${userId}|Пользователь] успешно разблокирован!`);

        } catch (error) {
            await context.send(`❌ Ошибка при разбане пользователя: ${error.message}`);
        }
    }

    static async adminCheckBan(context, userInput) {
        try {
            const adminData = Utils.loadData('admin.json');
            let userId = null;

            if (userInput.match(/^\d+$/)) {
                userId = userInput;
            } else {
                userId = Utils.extractUserId(userInput)?.toString();
            }

            if (!userId) {
                await context.send("❌ Не удалось определить пользователя!");
                return;
            }

            if (!adminData.ban?.users_ids?.includes(userId) || !adminData.ban[userId]) {
                await context.send("❌ Пользователь не забанен!");
                return;
            }

            const banInfo = adminData.ban[userId];
            const currentTime = Math.floor(Date.now() / 1000);
            const endTime = banInfo.time + (banInfo.days * 24 * 60 * 60);
            const remaining = endTime - currentTime;

            const startDate = new Date(banInfo.time * 1000).toLocaleString('ru-RU');
            const endDate = new Date(endTime * 1000).toLocaleString('ru-RU');

            let text = `🚫 Информация о бане [id${userId}|Пользователя]\n\n`;
            text += `📅 Начало: ${startDate}\n`;
            text += `📅 Конец: ${endDate}\n`;
            
            if (remaining > 0) {
                const daysLeft = Math.floor(remaining / (24 * 60 * 60));
                const hoursLeft = Math.floor((remaining % (24 * 60 * 60)) / 3600);
                text += `⏰ Осталось: ${daysLeft} дн. ${hoursLeft} час.\n`;
            } else {
                text += `⏰ Бан истек\n`;
            }
            
            text += `📝 Причина: ${banInfo.reason}\n`;
            text += `⏱️ Срок: ${banInfo.days} дней`;

            await context.send(text);

        } catch (error) {
            await context.send(`❌ Ошибка при проверке бана: ${error.message}`);
        }
    }

    static async handleKlanCommand(context, text) {
        await context.send("⚔️ Система кланов находится в разработке!");
    }

    static async joinKlanBattle(context, text) {
        await context.send("⚔️ Система битв кланов находится в разработке!");
    }

    static async handleLogin(context) {
        const userId = context.senderId.toString();
        const loginData = databaseLogin.get(userId);

        if (!loginData) {
            await context.send("Вы не пытаетесь войти в данный момент на сайт!");
            return;
        }

        await context.send("Согласие дано, напишите заново свой айди в форме, чтобы войти..");
        loginData.status = 'success';
        databaseLogin.set(userId, loginData);

        // Удалить через 5 минут
        setTimeout(() => {
            databaseLogin.delete(userId);
        }, 5 * 60 * 1000);
    }

    static async handleLoginCallback(context) {
        const userId = context.senderId.toString();
        const loginData = databaseLogin.get(userId);

        if (!loginData) {
            await context.send("Вы не пытаетесь войти в данный момент на сайт!");
            return;
        }

        await context.send("Вы дали согласие на вход! Теперь введите заново ваш айди в форме, чтобы войти. На вход даётся 5 минут!");
        loginData.status = 'success';
        databaseLogin.set(userId, loginData);

        // Удалить через 5 минут
        setTimeout(() => {
            databaseLogin.delete(userId);
        }, 5 * 60 * 1000);
    }

    static async showDonate(context) {
        const userInfo = await Utils.getUserInfo(context.senderId);
        
        const keyboard = Utils.createKeyboard([
            [
                { label: "Перейти на сайт", link: "https://racebotvk.pythonanywhere.com" }
            ]
        ], true);

        await context.send({
            message: `Привет, ${userInfo.first_name}, чтобы оплатить донат, перейдите на наш сайт. При входе вас попросят написать ваш айди, перейдите в лс бота и напишите 'мой айди'`,
            keyboard: keyboard
        });
    }

    static async handleBroadcast(context) {
        const adminIds = [819016396, 761815201];
        
        if (!adminIds.includes(context.senderId)) {
            await context.send("❌ У вас нет прав для рассылки!");
            return;
        }

        const broadcastText = context.text.substring(9).trim();

        if (!broadcastText) {
            await context.send("❌ Укажите текст для рассылки!\nПример: рассылка Привет всем!");
            return;
        }

        const formattedText = `📢 РАССЫЛКА ОТ АДМИНИСТРАЦИИ:\n\n${broadcastText}\n\n— Бот Гонки`;

        const chatsData = Utils.loadData('chats.json');
        const chats = chatsData.chats || {};

        if (Object.keys(chats).length === 0) {
            await context.send("❌ Нет чатов в базе данных!");
            return;
        }

        await context.send(`🚀 Начинаю рассылку в ${Object.keys(chats).length} чатов...`);

        let successCount = 0;
        const errorList = [];

        for (const [chatId, chatInfo] of Object.entries(chats)) {
            try {
                await vk.api.messages.send({
                    peer_id: parseInt(chatId),
                    message: formattedText,
                    random_id: Math.floor(Math.random() * 1000000)
                });
                successCount++;
                
                // Задержка чтобы не получить бан от VK API
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (error) {
                errorList.push(`${chatInfo.title || 'Без названия'} (ID: ${chatId}) - ${error.message}`);
            }
        }

        let report = `📊 РАССЫЛКА ЗАВЕРШЕНА:\n\n` +
                     `✅ Успешно: ${successCount}\n` +
                     `❌ Ошибок: ${errorList.length}\n` +
                     `📝 Всего чатов: ${Object.keys(chats).length}`;

        if (errorList.length > 0) {
            report += `\n\nПоследние ошибки:\n` + errorList.slice(0, 5).join('\n');
            if (errorList.length > 5) {
                report += `\n... и ещё ${errorList.length - 5} ошибок`;
            }
        }

        await context.send(report);
    }
}

// Инициализация и запуск бота
async function startBot() {
    try {
        console.log('🚀 Запуск Гонки бота...');

        // Обработка сообщений
        vk.updates.on('message_new', async (context, next) => {
            await BotHandler.handleMessage(context);
            await next();
        });

        // Запуск LongPoll
        await vk.updates.start({
            webhook: false
        });
        
        console.log('✅ LongPoll запущен успешно!');
        console.log('🤖 Бот готов к работе!');
        
    } catch (error) {
        console.error('❌ Ошибка запуска бота:', error);
        process.exit(1);
    }
}

// Обработка ошибок
process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

// Запуск бота
// Веб-сервер для Render
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        bot: 'VK Race Bot',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    const usersData = Utils.loadData('users.json');
    const chatsData = Utils.loadData('chats.json');
    
    res.json({
        status: 'ok',
        bot_status: 'running',
        users_count: Object.keys(usersData.users || {}).length,
        chats_count: Object.keys(chatsData.chats || {}).length,
        memory: process.memoryUsage()
    });
});
// Функция самопинга для Render
async function startSelfPing() {
    const RENDER_URL = process.env.RENDER_URL;
    
    if (!RENDER_URL) {
        console.log('⚠️ RENDER_URL не указан. Самопинг не активирован.');
        console.log('ℹ️ Укажите переменную окружения RENDER_URL в настройках Render');
        return;
    }
    
    console.log(`🔗 URL для самопинга: ${RENDER_URL}`);
    
    // Пингуем каждые 5 минут (300000 мс)
    setInterval(async () => {
        try {
            const axios = require('axios');
            const response = await axios.get(RENDER_URL);
            console.log(`🔄 Самопинг: ${response.status} - ${new Date().toLocaleTimeString()}`);
        } catch (error) {
            console.error('❌ Ошибка самопинга:', error.message);
        }
    }, 5 * 60 * 1000); // 5 минут
    
    // Пингуем сразу после запуска
    try {
        const axios = require('axios');
        await axios.get(RENDER_URL);
        console.log('✅ Первый пинг выполнен успешно');
    } catch (error) {
        console.error('❌ Первый пинг не удался:', error.message);
    }
}


async function initializeApp() {
    try {
        // Запускаем веб-сервер
        app.listen(PORT, () => {
            console.log(`🚀 Веб-сервер запущен на порту ${PORT}`);
            console.log(`🌐 Health check: http://localhost:${PORT}/health`);
        });

        // Запускаем самопинг
        await startSelfPing();

        // Запускаем бота
        await startBot();
        
    } catch (error) {
        console.error('❌ Ошибка запуска приложения:', error);
        process.exit(1);
    }
}
// Запуск веб-сервера и бота



initializeApp();
