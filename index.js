const { Client, GatewayIntentBits, ButtonBuilder, ButtonStyle } = require('discord.js');
const { ActionRowBuilder } = require('@discordjs/builders');
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const mysql = require('mysql2/promise');

// Create a connection to the database
let connection;

// Async initialization function to load config and set up the database connection
async function initialize() {
    try {
        // Load the token and database configuration from config.json
        const config = JSON.parse(await fs.readFile(path.join(__dirname, 'config.json'), 'utf8'));

        connection = mysql.createPool({
            host: config.mysql.host,
            port: config.mysql.port,
            user: config.mysql.user,
            password: config.mysql.password,
            database: config.mysql.database
        });

        const TOKEN = config.discord.token;

        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        client.once('ready', () => {
            console.log(`Logged in as ${client.user.tag}`);
        });

        client.on('error', console.error);
        client.on('shardError', error => {
            console.error('A websocket connection encountered an error:', error);
        });

        async function isGzipped(file) {
            const buffer = await fs.readFile(file);
            return buffer[0] === 0x1f && buffer[1] === 0x8b;
        }

        client.on('messageCreate', async message => {
            console.log(`Received message: ${message.content}`);
            if (message.content.startsWith('!pokedex')) {
                const args = message.content.split(' ');
                const playerName = args[1];
                let page = args[2] ? parseInt(args[2]) : 1;

                if (!playerName) {
                    message.channel.send('Please provide a player name.');
                    return;
                }

                const pokedexData = await getPokedexData(playerName, page);

                if (pokedexData) {
                    displayPokedex(message, playerName, pokedexData);
                } else {
                    message.channel.send('Could not retrieve data for that player.');
                }
            }
        });

        async function getPokedexData(playerName, page = 1, pageSize = 15) {
            const testDataDir = path.join(__dirname, '..', 'world', 'data', 'pokemon');
            const files = await fs.readdir(testDataDir);

            const caughtPokemonSet = new Set();

            for (const file of files) {
                const filePath = path.join(testDataDir, file);
                if (file.endsWith('.pk')) {
                    try {
                        console.log(`Processing file: ${file}`);
                        let pkData = await fs.readFile(filePath);

                        if (await isGzipped(filePath)) {
                            pkData = zlib.gunzipSync(pkData);
                        }

                        let pkString = pkData.toString('utf8');

                        const regex = new RegExp(`player\\s*[\\s\\S]*${playerName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}[\\s\\S]*`, 'gi');
                        const playerNameIndex = pkString.search(regex);
                        console.log(`Player name index: ${playerNameIndex}`);
                        if (playerNameIndex !== -1) {
                            console.log(`Found player: ${playerName}`);

                            const pokemonData = pkString.match(/\d+:\d+/g) || [];
                            console.log("Pokemon Data:", pokemonData);

                            if (pokemonData) {
                                for (const entry of pokemonData) {
                                    const [pokemonId, status] = entry.split(":").map(Number);
                                    console.log(`Pokemon ID: ${pokemonId}, Status: ${status}`);
                                    if (status === 2) {
                                        caughtPokemonSet.add(pokemonId);
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`Error processing file ${file}:`, error);
                    }
                }
            }

            const caughtPokemonIds = Array.from(caughtPokemonSet);
            console.log('Caught Pokemon IDs:', caughtPokemonIds);

            const uncaughtPokemonInfo = await fetchUncaughtPokemonInfo(caughtPokemonIds);

            if (uncaughtPokemonInfo) {
                const totalUncaught = uncaughtPokemonInfo.length;
                const totalPages = Math.ceil(totalUncaught / pageSize);
                const startIndex = (page - 1) * pageSize;
                const endIndex = Math.min(startIndex + pageSize, totalUncaught);

                const currentPagePokemon = uncaughtPokemonInfo.slice(startIndex, endIndex);

                return {
                    playerName: playerName,
                    caught: caughtPokemonIds.length,
                    uncaught: 981 - caughtPokemonIds.length,
                    totalPages,
                    currentPage: page,
                    pokemonInfo: currentPagePokemon,
                };
            } else {
                console.error('Error fetching uncaught Pokemon info.');
                return null;
            }
        }

        async function fetchUncaughtPokemonInfo(caughtPokemonIds) {
            try {
                let sql = `SELECT pokemonid, name, evolve FROM pokedex`;
        
                if (caughtPokemonIds.length > 0) {
                    const placeholders = caughtPokemonIds.map(() => '?').join(',');
                    sql += ` WHERE pokemonid NOT IN (${placeholders})`;
                }
        
                sql += ` ORDER BY pokemonid`;
        
                console.log('SQL Query:', sql);
                console.log('Caught Pokemon IDs:', caughtPokemonIds);
        
                const [rows, fields] = await connection.query(sql, caughtPokemonIds);
        
                if (!rows || !Array.isArray(rows)) {
                    console.error('No rows returned from the database query.');
                    return null;
                }
        
                return rows;
            } catch (error) {
                console.error('Error fetching uncaught Pokemon info:', error);
                return null;
            }
        }
        

        async function displayPokedex(message, playerName, pokedexData) {
            const embed = createEmbed(pokedexData);
        
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('previous_page')
                        .setLabel('◀️')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('next_page')
                        .setLabel('▶️')
                        .setStyle(ButtonStyle.Primary),
                );
        
            const sentMessage = await message.channel.send({ embeds: [embed], components: [row] });
        
            const filter = (interaction) => {
                return interaction.isButton() && interaction.user.id === message.author.id;
            };
        
            const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });
        
            collector.on('collect', async (interaction) => {
                try {
                    if (interaction.customId === 'previous_page') {
                        let targetPage = pokedexData.currentPage - 1;
                        if (targetPage < 1) {
                            targetPage = pokedexData.totalPages;
                        }
                        const prevPageData = await getPokedexData(playerName, targetPage);
                        await interaction.update({ embeds: [createEmbed(prevPageData)], components: [row] });
                        pokedexData.currentPage = targetPage;
                    } else if (interaction.customId === 'next_page') {
                        let targetPage = pokedexData.currentPage + 1;
                        if (targetPage > pokedexData.totalPages) {
                            targetPage = 1;
                        }
                        const nextPageData = await getPokedexData(playerName, targetPage);
                        await interaction.update({ embeds: [createEmbed(nextPageData)], components: [row] });
                        pokedexData.currentPage = targetPage;
                    }
                } catch (error) {
                    console.error('Error handling interaction:', error);
                    interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
                }
            });
        
            collector.on('end', () => {
                sentMessage.edit({ components: [] });
            });
        }
        
        function createEmbed(pokedexData) {
            let response = `${pokedexData.playerName} has caught ${pokedexData.caught} Pokemon and has ${pokedexData.uncaught} Pokemon left.\n`;
            let pokemonList = '';
        
            if (pokedexData.pokemonInfo && pokedexData.pokemonInfo.length > 0) {
                pokemonList += `Uncaught Pokemon Pages ${pokedexData.currentPage}/${pokedexData.totalPages}:\n`;
                pokedexData.pokemonInfo.forEach(pokemon => {
                    pokemonList += `ID: ${pokemon.pokemonid}, Name: ${pokemon.name}`;
                    if (pokemon.evolve) {
                        pokemonList += `, Evolve: ${pokemon.evolve}\n`;
                    } else {
                        pokemonList += '\n';
                    }
                });
            }
        
            return {
                title: 'Pokedex',
                description: response + pokemonList,
            };
        }

        client.login(TOKEN);
    } catch (error) {
        console.error('Error during initialization:', error);
    }
}

initialize();
