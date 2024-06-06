const { Client, GatewayIntentBits, ButtonBuilder, ButtonStyle } = require('discord.js');
const { ActionRowBuilder } = require('@discordjs/builders');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mysql = require('mysql2');

// Load the token and database configuration from config.json
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// Create a connection to the database
const connection = mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database
});

// Connect to the database
connection.connect(err => {
    if (err) {
        console.error('Error connecting to the database:', err);
        return;
    }
    console.log('Connected to the MySQL database');
});

const TOKEN = config.discord.token;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Event listener when the bot is ready
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

// Error handling
client.on('error', console.error);
client.on('shardError', error => {
    console.error('A websocket connection encountered an error:', error);
});

// Function to check if a file is gzipped
function isGzipped(file) {
    const buffer = fs.readFileSync(file);
    return buffer[0] === 0x1f && buffer[1] === 0x8b;
}

// Command to get Pokedex data with pagination
client.on('messageCreate', async message => {
    console.log(`Received message: ${message.content}`);
    if (message.content.startsWith('!pokedex')) {
        const args = message.content.split(' ');
        const playerName = args[1];
        let page = args[2] ? parseInt(args[2]) : 1; // Parse the page number from command arguments

        if (!playerName) {
            message.channel.send('Please provide a player name.');
            return;
        }

        const pokedexData = await getPokedexData(playerName, page); // Pass page number to getPokedexData

        if (pokedexData) {
            displayPokedex(message, playerName, pokedexData);
        } else {
            message.channel.send('Could not retrieve data for that player.');
        }
    }
});

async function getPokedexData(playerName, page = 1, pageSize = 10) {
    const testDataDir = path.join(__dirname, 'test-data');
    const files = fs.readdirSync(testDataDir);

    const caughtPokemonSet = new Set(); // Initialize a Set to store caught Pokemon IDs

    for (const file of files) {
        const filePath = path.join(testDataDir, file);
        if (file.endsWith('.pk')) { // Check if the file is a .pk file
            try {
                console.log(`Processing file: ${file}`);
                let pkData = fs.readFileSync(filePath);

                // Check if the file is gzipped
                if (isGzipped(filePath)) {
                    pkData = zlib.gunzipSync(pkData);
                }

                // Convert pkData to string
                let pkString = pkData.toString('utf8');

                // Find the position of the player's username
                // Update the regular expression pattern
                const regex = new RegExp(`player\\s*[\\s\\S]*${playerName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}[\\s\\S]*`, 'gi');
                const playerNameIndex = pkString.search(regex);
                console.log(`Player name index: ${playerNameIndex}`);
                if (playerNameIndex !== -1) {
                    console.log(`Found player: ${playerName}`);

                    // Extract the Pokemon data entries
                    const pokemonData = pkString.match(/\d+:\d+/g) || [];
                    console.log("Pokemon Data:", pokemonData); // Debug line

                    if (pokemonData) {
                        // Loop through each Pokemon data entry
                        for (const entry of pokemonData) {
                            // Split entry by colon (":")
                            const [pokemonId, status] = entry.split(":").map(Number);
                            console.log(`Pokemon ID: ${pokemonId}, Status: ${status}`);
                            // Add the Pokemon ID to the set if status is 2 (caught)
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

    // Convert the Set to an array of Pokemon IDs
    const caughtPokemonIds = Array.from(caughtPokemonSet);
    console.log('Caught Pokemon IDs:', caughtPokemonIds); // Log the caught Pokemon IDs

    // Fetch Pokemon information from the database based on the caught Pokemon IDs
    const pokemonInfo = await fetchPokemonInfo(caughtPokemonIds);

    if (pokemonInfo) {
        // Calculate pagination
        const totalPokemon = pokemonInfo.length;
        const totalPages = Math.ceil(totalPokemon / pageSize);
        const startIndex = (page - 1) * pageSize;
        const endIndex = Math.min(startIndex + pageSize, totalPokemon);

        // Extract the current page's Pokemon info
        const currentPagePokemon = pokemonInfo.slice(startIndex, endIndex);

        return {
            playerName: playerName,
            caught: totalPokemon,
            uncaught: 981 - totalPokemon,
            totalPages,
            currentPage: page,
            pokemonInfo: currentPagePokemon,
        };
    } else {
        console.error('Error fetching Pokemon info.');
        return null;
    }
}

async function fetchPokemonInfo(caughtPokemonIds) {
    try {
        // Prepare the SQL query to fetch Pokemon information for caught Pokemon IDs
        const placeholders = caughtPokemonIds.map(() => '?').join(',');
        const sql = `SELECT pokemonid, name, evolve FROM pokedex WHERE pokemonid IN (${placeholders})`;

        console.log('SQL Query:', sql); // Log the SQL query
        console.log('Caught Pokemon IDs:', caughtPokemonIds); // Log the caught Pokemon IDs

        // Execute the SQL query with the caught Pokemon IDs as parameters
        const [rows, fields] = await connection.promise().query(sql, caughtPokemonIds); // Modify this line

        // Check if rows is valid before proceeding
        if (!rows || !Array.isArray(rows)) {
            console.error('No rows returned from the database query.');
            return null;
        }

        // Return the fetched Pokemon information
        return rows;
    } catch (error) {
        console.error('Error fetching Pokemon info:', error);
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

    // Filter for button interactions
    const filter = (interaction) => {
        return interaction.isButton() && interaction.user.id === message.author.id;
    };

    const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 }); // Extend time to 60 seconds

    collector.on('collect', async (interaction) => {
        if (interaction.customId === 'previous_page' && pokedexData.currentPage > 1) {
            const prevPageData = await getPokedexData(playerName, pokedexData.currentPage - 1);
            await interaction.update({ embeds: [createEmbed(prevPageData)], components: [row] });
        } else if (interaction.customId === 'next_page' && pokedexData.currentPage < pokedexData.totalPages) {
            const nextPageData = await getPokedexData(playerName, pokedexData.currentPage + 1);
            await interaction.update({ embeds: [createEmbed(nextPageData)], components: [row] });
        }
    });

    collector.on('end', () => {
        sentMessage.edit({ components: [] }); // Remove buttons when collector ends
    });
}

function createEmbed(pokedexData) {
    let response = `${pokedexData.playerName} has caught ${pokedexData.caught} Pokemon and has ${pokedexData.uncaught} Pokemon left.\n`;
    let pokemonList = '';

    // Check if there is Pokemon information available
    if (pokedexData.pokemonInfo && pokedexData.pokemonInfo.length > 0) {
        pokemonList += `Page ${pokedexData.currentPage}/${pokedexData.totalPages}:\n`;
        // Iterate over each caught Pokemon and append its details to the response
        pokedexData.pokemonInfo.forEach(pokemon => {
            pokemonList += `ID: ${pokemon.pokemonid}, Name: ${pokemon.name}, Evolve: ${pokemon.evolve}\n`;
        });
    }

    return {
        title: 'Pokedex',
        description: response + pokemonList,
    };
}

client.login(TOKEN);
