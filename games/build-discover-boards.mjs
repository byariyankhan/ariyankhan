// Build the discovery boards for Arrow Atlas: after a country's outline the player clears a board shaped like
// something a traveller would find there (its animal, its bird or a landmark). Shapes are Twemoji glyphs
// (graphics CC-BY 4.0, https://github.com/twitter/twemoji) traced to a single outline with potrace, scaled into
// the same REF box as the country outlines and flattened to straight segments (M/L/Z only, the one path form the
// game's parser reads), so the game's rasteriser and generator need no changes. A few shapes that no glyph
// carries well (the pyramids) are drawn by hand in CUSTOM.
// Usage (from the repo root, one-off): npm i --no-save sharp potrace @twemoji/svg && node games/build-discover-boards.mjs
// Then bump DISCB_VERSION in js/arrow-atlas.js so edges drop the old file.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp'); const potrace = require('potrace');
const TW = new URL('../' + (process.env.TWEMOJI_DIR || 'node_modules/@twemoji/svg/'), import.meta.url).pathname;
const disc = JSON.parse(fs.readFileSync(new URL('./data/discover.json', import.meta.url), 'utf8')).items;
const levels = JSON.parse(fs.readFileSync(new URL('./data/arrow-atlas.json', import.meta.url), 'utf8')).levels;
const OUT = new URL('./data/discover-boards.json', import.meta.url).pathname;
const js = fs.readFileSync(new URL('../js/arrow-atlas.js', import.meta.url), 'utf8');
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
const { rasterise, REF } = new Function([grab(/const REF = \d+;/), grab(/function parsePath\(d\) \{[\s\S]*?\n  \}\n/), grab(/function insidePath\([\s\S]*?\n  \}\n/), grab(/function rasterise\([\s\S]*?\n  \}\n/)].join('\n') + '\nreturn { rasterise, REF };')();
const TARGETS = [110, 240, 400, 700, 900], MAX_DIM_OF = [32, 32, 32, 40, 44], MAX_TALL_OF = [46, 46, 46, 54, 58], MAX_WIDE_OF = [38, 38, 38, 46, 50];

// Which glyph stands for a find: ordered keyword rules over the discovery text (first match wins)
const RULES = [
  ['tiger', '1f405'], ['leopard', '1f406'], ['cheetah', '1f406'], ['jaguar', '1f406'], ['ocelot', '1f406'], ['lynx', '1f406'],
  ['elephant', '1f418'], ['rhino', '1f98f'], ['hippo', '1f99b'], ['dromedary', '1f42a'], ['camel', '1f42a'], ['giraffe', '1f992'], ['okapi', '1f992'],
  ['kangaroo', '1f998'], ['gorilla', '1f98d'], ['orangutan', '1f9a7'], ['chimpanzee', '1f412'], ['monkey', '1f412'], ['macaque', '1f412'], ['mandrill', '1f412'], ['lemur', '1f412'],
  ['crocodile', '1f40a'], ['tortoise', '1f422'], ['turtle', '1f422'], ['iguana', '1f98e'], ['lizard', '1f98e'], ['dragon', '1f409'], ['boa', '1f40d'], ['snake', '1f40d'],
  ['whale shark', '1f988'], ['shark', '1f988'], ['whale', '1f40b'], ['dolphin', '1f42c'], ['marlin', '1f41f'], ['coelacanth', '1f41f'],
  ['flamingo', '1f9a9'], ['peafowl', '1f99a'], ['peacock', '1f99a'], ['pheasant', '1f99a'], ['monal', '1f99a'], ['quetzal', '1f99a'], ['junglefowl', '1f413'], ['rooster', '1f413'],
  ['parrot', '1f99c'], ['macaw', '1f99c'], ['amazon', '1f99c'], ['lory', '1f99c'], ['lorikeet', '1f99c'], ['penguin', '1f427'], ['dove', '1f54a'], ['pigeon', '1f54a'], ['dodo', '1f9a4'],
  ['eagle', '1f985'], ['condor', '1f985'], ['vulture', '1f985'], ['falcon', '1f985'], ['hawk', '1f985'], ['osprey', '1f985'], ['kestrel', '1f985'],
  ['swan', '1f9a2'], ['duck', '1f986'], ['owl', '1f989'],
  ['sloth', '1f9a5'], ['otter', '1f9a6'], ['beaver', '1f9ab'], ['bison', '1f9ac'], ['aurochs', '1f402'], ['bull', '1f402'], ['ox', '1f402'], ['water buffalo', '1f403'], ['carabao', '1f403'], ['buffalo', '1f403'], ['takin', '1f403'], ['kouprey', '1f403'], ['cow', '1f404'],
  ['ibex', '1f410'], ['chamois', '1f410'], ['tur', '1f410'], ['markhor', '1f410'], ['goat', '1f410'], ['mouflon', '1f40f'],
  ['deer', '1f98c'], ['huemul', '1f98c'], ['antelope', '1f98c'], ['oryx', '1f98c'], ['gemsbok', '1f98c'], ['springbok', '1f98c'], ['kob', '1f98c'], ['vicuña', '1f999'], ['llama', '1f999'], ['guanaco', '1f999'],
  ['horse', '1f40e'], ['zebra', '1f993'], ['hare', '1f407'], ['rabbit', '1f407'], ['bat', '1f987'], ['flying fox', '1f987'], ['crab', '1f980'], ['langouste', '1f99e'], ['dugong', '1f9ad'], ['seal', '1f9ad'],
  ['bee', '1f41d'], ['ladybird', '1f41e'], ['hedgehog', '1f994'], ['shrew', '1f994'], ['solenodon', '1f994'], ['tapir', '1f417'], ['hound', '1f415'], ['dog', '1f415'],
  ['panda', '1f43c'], ['fox', '1f98a'], ['bear', '1f43b'], ['wolf', '1f43a'], ['koala', '1f428'], ['lion', '1f981'],
  ['frigatebird', '1f426'], ['crane', '1f426'], ['stork', '1f426'], ['ibis', '1f426'], ['pelican', '1f426'], ['hornbill', '1f426'], ['toucan', '1f426'], ['kiwi', '1f426'], ['emu', '1f426'], ['ostrich', '1f426'], ['sunbird', '1f426'], ['hoopoe', '1f426'], ['bird', '1f426'], ['robin', '1f426'], ['thrush', '1f426'], ['magpie', '1f426'], ['nightingale', '1f426'], ['turaco', '1f426'], ['motmot', '1f426'], ['roller', '1f426'], ['bustard', '1f426'], ['shoebill', '1f426'], ['tern', '1f426'], ['warbler', '1f426'], ['lapwing', '1f426'], ['trogon', '1f426'], ['streamertail', '1f426'], ['kiskadee', '1f426'], ['troupial', '1f426'], ['bellbird', '1f426'], ['palmchat', '1f426'], ['megapode', '1f426'], ['manumea', '1f426'], ['grosbeak', '1f426'], ['rockfowl', '1f426'], ['francolin', '1f426'], ['partridge', '1f426'], ['hornero', '1f426'], ['dipper', '1f426'], ['godwit', '1f426'], ['blackbird', '1f426'], ['wagtail', '1f426'], ['sparrow', '1f426'], ['swallow', '1f426'], ['raven', '1f426'], ['goshawk', '1f426'], ['sisserou', '1f99c'], ['jacquot', '1f99c'], ['huma', '1f426'], ['turul', '1f985'],
];
// A landmark glyph where it says more than the animal (or the animal is only a face)
// A hand-drawn shape overrides the keyword rules the same way a landmark does.
const PLACE = { MM: ['a', 'peacock'], CR: ['a', 'sloth'], CY: ['a', 'mouflon'], UG: ['a', 'gorilla'], RW: ['a', 'gorilla'], CG: ['a', 'gorilla'], GA: ['a', 'gorilla'],
   JP: ['p', '1f5fb'], CL: ['p', '1f5ff'], IT: ['p', '1f3db'], GR: ['p', '1f3db'], US: ['p', 'liberty'], VA: ['p', '26ea'], SA: ['p', 'kaaba'], KH: ['p', '1f6d5'], TR: ['p', '1f54c'], IN: ['a', '1f405'], MA: ['p', '1f54c'], IR: ['p', '1f54c'], KR: ['p', '1f3ef'], DE: ['p', '1f3f0'], GB: ['p', '1f3f0'], CZ: ['p', '1f3f0'], RO: ['p', '1f3f0'], ES: ['a', '1f402'], PT: ['b', '1f413'], IS: ['p', '1f30b'], EC: ['a', '1f422'], NP: ['p', '1f3d4'], PK: ['p', '1f3d4'], CH: ['p', '1f3d4'], AT: ['p', '1f3d4'], TZ: ['p', '1f3d4'], VU: ['p', '1f30b'], SV: ['p', '1f30b'], NI: ['p', '1f30b'], CV: ['p', '1f30b'], KM: ['p', '1f30b'], VC: ['p', '1f30b'], SM: ['p', '1f3f0'], LI: ['p', '1f3f0'], MC: ['p', '1f3f0'], LU: ['p', '1f3f0'], EG: ['p', 'pyramids'], BH: ['p', '1f54c'], KW: ['p', '1f54c'], QA: ['p', '1f54c'], AE: ['p', '1f54c'], OM: ['p', '1f3f0'], BN: ['p', '1f54c'], MV: ['a', '1f988'], TH: ['a', '1f418'], TW: ['a', '1f43b'], HU: ['p', '1f3db'], IL: ['p', '1f54d'], PS: ['p', '1f54c'], AM: ['p', '26ea'], GE: ['p', '26ea'], ET: ['p', '26ea'], RU: ['p', '1f3f0'] };
// What the place board is called: the glyph shows one landmark, the discovery text often names two
const LABEL = { IT: 'The Pantheon, Rome', JP: 'Mount Fuji', GB: 'Windsor Castle', US: 'Statue of Liberty', EG: 'Pyramids of Giza', RU: 'Moscow Kremlin', TR: 'Blue Mosque, Istanbul', DE: 'Neuschwanstein Castle', SA: 'The Kaaba, Mecca', IR: 'Shah Mosque, Isfahan', ET: 'Church of St George, Lalibela', TZ: 'Mount Kilimanjaro', PK: 'K2', CL: 'Moai of Easter Island', NP: 'Mount Everest', GR: 'The Parthenon, Athens', KR: 'Gyeongbokgung Palace', IS: 'Hekla volcano', MA: 'Hassan II Mosque, Casablanca', RO: 'Bran Castle', KH: 'Angkor Wat', CZ: 'Prague Castle', AE: 'Sheikh Zayed Grand Mosque', HU: 'Hungarian Parliament', IL: 'Great Synagogue, Jerusalem', AT: 'Grossglockner, the Alps', CH: 'The Matterhorn', NI: 'Momotombo volcano', SV: 'Izalco volcano', OM: 'Nizwa Fort', PS: 'Ibrahimi Mosque, Hebron', KW: 'Grand Mosque of Kuwait', GE: 'Gergeti Trinity Church', AM: 'Geghard Monastery', QA: 'Qatar State Mosque', BH: 'Al Fateh Grand Mosque', KM: 'Mount Karthala', LU: 'Vianden Castle', CV: 'Pico do Fogo', BN: 'Sultan Omar Ali Saifuddien Mosque', VU: 'Mount Yasur', VC: 'La Soufrière', MC: "Prince's Palace of Monaco", LI: 'Vaduz Castle', SM: 'Guaita Tower', VA: "St Peter's Basilica" };
// Hand-drawn shapes (REF box, y down, M/L/Z only, one ring each) where no glyph survives being traced.
//
// Two reasons a glyph fails. Some Twemoji carry a full-bleed background, so potrace traces the tile and not the
// subject: 1f5fd gave a rounded square for the Statue of Liberty and 1f54b a flat slab for the Kaaba. Others are
// faces or fans whose outline says nothing once it is one flat colour — a peacock's fan becomes a dome, a
// gorilla's face an egg. These are drawn instead, and must stay chunky: the leanest board already in the game
// deals 586 arrows on Master, and a shape made of thin parts cannot reach that.
//
// Every ring is traced in one direction and never crosses itself, because the game's mask test (insidePath) is
// even-odd: an overlap would punch its own hole.
const CUSTOM = {
  pyramids: 'M 0 100 L 36 12 L 72 100 Z M 72 100 L 86 52 L 100 100 Z',
  liberty: 'M 70 0 L 74 1 L 76 6 L 73 10 L 76 14 L 74 16 L 72 28 L 66 40 L 72 46 L 74 56 L 76 70 L 78 80 L 84 82 L 84 100 L 16 100 L 16 82 L 22 80 L 24 66 L 26 56 L 18 58 L 16 48 L 26 44 L 30 38 L 38 36 L 38 30 L 36 24 L 38 20 L 36 13 L 41 17 L 43 10 L 46 17 L 49 9 L 52 17 L 55 11 L 57 18 L 60 14 L 58 21 L 60 26 L 58 32 L 58 36 L 62 38 L 64 26 L 66 14 L 66 11 L 64 7 L 66 2 Z',
  kaaba: 'M 14 44 L 34 26 L 86 26 L 86 82 L 66 100 L 14 100 Z',
  peacock: 'M 64 6 L 60 14 L 67 13 L 63 21 L 70 19 L 67 27 L 75 25 L 71 33 L 80 32 L 84 40 L 78 46 L 70 48 L 66 56 L 72 62 L 84 70 L 90 82 L 86 92 L 90 95 L 86 98 L 78 95 L 72 98 L 68 94 L 70 86 L 56 92 L 40 94 L 26 92 L 14 96 L 4 92 L 2 82 L 12 74 L 26 70 L 38 66 L 48 60 L 54 50 L 56 38 L 58 22 L 60 12 Z',
  sloth: 'M 0 14 L 100 14 L 100 24 L 76 24 L 78 34 L 74 46 L 66 54 L 70 66 L 68 80 L 58 90 L 44 92 L 30 88 L 22 76 L 22 62 L 14 52 L 10 38 L 14 26 L 24 24 L 22 34 L 26 44 L 34 50 L 40 46 L 52 46 L 60 50 L 68 44 L 70 32 L 66 24 L 0 24 Z',
  gorilla: 'M 50 8 L 60 12 L 64 20 L 62 28 L 70 32 L 80 42 L 84 56 L 88 70 L 86 84 L 78 88 L 74 80 L 76 66 L 70 58 L 70 74 L 68 86 L 58 90 L 50 88 L 42 90 L 32 86 L 30 74 L 30 58 L 24 66 L 26 80 L 22 88 L 14 84 L 12 70 L 16 56 L 20 42 L 30 32 L 38 28 L 36 20 L 40 12 Z',
  mouflon: 'M 40 42 L 58 37 L 78 40 L 92 50 L 96 64 L 92 80 L 86 68 L 82 58 L 82 76 L 78 92 L 68 92 L 72 74 L 68 64 L 50 66 L 44 78 L 40 92 L 30 92 L 34 72 L 30 60 L 26 62 L 20 58 L 18 50 L 22 11.3 L 30 11.3 L 37.5 14.1 L 43.6 19.2 L 47.6 26.1 L 49 34 L 47.6 41.9 L 43.6 48.8 L 37.5 53.9 L 30 56.7 L 22 56.7 L 14.5 53.9 L 8.4 48.8 L 19.1 39.8 L 21.5 41.8 L 24.4 42.9 L 27.6 42.9 L 30.5 41.8 L 32.9 39.8 L 34.5 37.1 L 35 34 L 34.5 30.9 L 32.9 28.2 L 30.5 26.2 L 27.6 25.1 L 30 30 L 38 32 Z',
};
// What the result card says after a discovery board: [how the find relates to the country, one odd fact]
const ABOUT = {
  IT: ["Rome's best-kept ancient temple", "Its concrete dome is still the largest unreinforced one on Earth after 1,900 years, with an open hole at the top that lets the rain in."],
  IN: ["India's national animal", "No two tigers share the same stripes, and the pattern is on the skin, not just the fur."],
  AU: ["Australia's national animal", "It cannot walk backwards, which is one reason it was put on the coat of arms."],
  BR: ["the biggest cat of the Americas and a symbol of Brazil", "Its bite is strong enough to crack a turtle shell, and it happily swims after caimans."],
  BD: ["Bangladesh's national animal", "The tigers of the Sundarbans swim between islands and drink slightly salty water."],
  JP: ["Japan's sacred mountain and highest peak", "It is an active volcano that last erupted in 1707, and about 200,000 people climb it every summer."],
  GB: ["the oldest castle in the world still lived in by a royal family", "It has been a royal home for over 900 years, since William the Conqueror."],
  US: ["the gift France sent to the United States in 1886", "Its copper skin is only as thick as two coins, and it turned green within about 30 years."],
  CN: ["China's national treasure", "It spends up to 14 hours a day eating bamboo yet has the stomach of a meat-eater."],
  EG: ["the last of the seven wonders of the ancient world still standing", "The Great Pyramid was the tallest building on Earth for nearly 4,000 years."],
  MX: ["Mexico's national bird, on its flag", "Legend says the Aztecs built their capital where they saw one perched on a cactus eating a snake."],
  AR: ["Argentina's national animal", "'Jaguar' comes from a Guaraní word meaning 'the one that kills in a single leap'."],
  CA: ["Canada's national animal", "Its teeth never stop growing and are orange because of the iron that makes them hard."],
  RU: ["the fortress at the heart of Russia", "Its walls hold the Tsar Bell, the largest bell ever cast, which has never once been rung."],
  TR: ["Istanbul's mosque of 20,000 blue tiles", "It has six minarets, which caused a stir in 1616 because only Mecca's mosque had that many."],
  FR: ["France's unofficial national animal", "The joke behind it: the Latin word gallus meant both 'rooster' and 'a Gaul'."],
  ES: ["Spain's most famous animal, on hillside billboards across the country", "The giant black bull silhouettes by the roads started as a brandy advert in 1956 and are now protected as art."],
  DE: ["the fairy-tale castle of Bavaria", "King Ludwig II built it in the 1800s to look medieval, and it inspired Disney's Sleeping Beauty castle."],
  SA: ["the holiest site in Islam, in Mecca", "Muslims everywhere face towards it to pray, and its black cloth cover is replaced every year."],
  ID: ["Indonesia's national animal and the largest lizard alive", "It grows to three metres and its saliva carries venom."],
  ZA: ["South Africa's national animal", "It can leap two metres straight up in a stiff-legged jump called pronking."],
  IR: ["the jewel of Isfahan's great square", "Stand under its dome and clap: the echo comes back seven times."],
  KZ: ["the symbol of Kazakhstan", "Its tail is almost as long as its body and doubles as a scarf in the cold."],
  DZ: ["Algeria's national bird", "It would rather run than fly and lives in the dry Atlas hills."],
  CD: ["DR Congo's national animal, found nowhere else", "It has zebra stripes on its legs but its closest relative is the giraffe."],
  SD: ["Sudan's national bird, on its coat of arms", "It kills snakes by stamping on them with kicks that land in a hundredth of a second."],
  LY: ["the giant bird of Libya's desert", "It is the largest bird alive, and its eye is bigger than its brain."],
  MN: ["Mongolia's takhi, the last truly wild horse", "It vanished from the wild in the 1960s and was brought back from zoo herds."],
  PE: ["Peru's national animal, on its coat of arms", "Its wool is among the finest in the world, and the Inca allowed only royalty to wear it."],
  TD: ["Chad's rare giraffe", "Fewer than 2,000 are left, and a giraffe's neck has the same seven bones as yours."],
  NE: ["Niger's giraffe, the last herd in West Africa", "Only about 50 survived in the 1990s; today there are over 600."],
  AO: ["Angola's national animal", "Its curved horns can pass 1.5 metres, and it was feared extinct after the civil war until a herd was found in 2004."],
  ML: ["the desert elephant of Mali", "Mali's herd makes the longest elephant migration known, a loop of about 600 km through the Sahel."],
  CO: ["Colombia's national bird", "With a three-metre wingspan it can glide for hours without a single flap."],
  ET: ["Ethiopia's church carved down into the rock at Lalibela", "It was cut out of a single block of red rock around 800 years ago, roof first."],
  BO: ["Bolivia's national animal", "It hums to its herd and spits when it is annoyed."],
  MR: ["Mauritania's ship of the desert", "Its hump stores fat, not water, and it can drink 100 litres in ten minutes."],
  TZ: ["Africa's highest mountain", "It is a sleeping volcano you can walk to the top of without ropes, crossing five climates on the way."],
  NG: ["Nigeria's national bird, on its coat of arms", "The eagle stands for strength; the two horses beside it stand for dignity."],
  VE: ["Venezuela's national bird", "It never builds its own nest; it takes over another bird's."],
  PK: ["Pakistan's giant, the second-highest mountain on Earth", "It is steeper and deadlier than Everest and was not climbed in winter until 2021."],
  NA: ["Namibia's national animal", "It can go months without drinking, getting water from the plants it eats."],
  MZ: ["the giant of Mozambique's Gorongosa park", "An elephant can recognise itself in a mirror and mourns its dead."],
  CL: ["the stone heads of Easter Island", "The heads have bodies: most are buried up to the shoulders."],
  ZM: ["Zambia's national bird", "Its cry is so well known it is called 'the voice of Africa'."],
  MM: ["Myanmar's national bird", "It appears on old Burmese coins and flags, and unlike the Indian peacock the female is bright green too."],
  AF: ["the ghost of Afghanistan's mountains", "It cannot roar; it chuffs and purrs instead."],
  SS: ["South Sudan's antelope", "Over a million kob cross the country every year, one of the largest animal migrations on Earth."],
  SO: ["Somalia's national animal", "It drags prey twice its weight up into trees to keep it from lions and hyenas."],
  CF: ["the smaller elephant of the Central African rainforest", "It is a separate species from the savanna elephant, with straighter tusks that point down."],
  UA: ["Ukraine's national bird", "Only the male sings, and he can know over 200 different songs."],
  MG: ["Madagascar's most famous animal", "Lemurs exist only on Madagascar, and this one sunbathes sitting upright like a yogi."],
  BW: ["Botswana's national animal, on its flag", "Every zebra's stripes are unique, and they seem to confuse biting flies."],
  KE: ["Kenya's most photographed bird", "It has about eight colours on it and rolls in the air during its courtship flight."],
  YE: ["Yemen's rarest cat", "Fewer than 200 are left in the wild across all of Arabia."],
  TH: ["Thailand's national animal", "White elephants were once so sacred that only the king could keep them."],
  SE: ["Sweden's national bird", "Its song is often the first heard at dawn, and it can copy other birds and even car alarms."],
  NO: ["Norway's national bird", "It is a songbird that walks underwater along riverbeds to hunt."],
  PL: ["Poland's national bird, on its coat of arms", "Its wingspan reaches 2.5 metres, the widest of any European eagle."],
  VN: ["the animal of Vietnam's rice fields", "Its wide hooves stop it sinking in mud, and it loves to wallow to keep cool."],
  PH: ["the Philippines' national animal", "It is a swamp buffalo that has pulled the country's ploughs for centuries."],
  MY: ["Malaysia's national animal, on its coat of arms", "Fewer than 150 remain in the wild; it is smaller than its Bengal cousin."],
  NZ: ["New Zealand's national bird", "It lays an egg a fifth of its own weight, and it has nostrils at the tip of its beak."],
  NP: ["Nepal's Sagarmatha, the top of the world", "It grows about 4 millimetres a year as India keeps pushing into Asia."],
  LK: ["Sri Lanka's elephant", "Only a few percent of the males grow tusks, the lowest rate of any Asian elephant."],
  GR: ["the temple on the Acropolis of Athens", "Its columns lean slightly inward and bulge in the middle so they look perfectly straight from below."],
  PT: ["Portugal's symbol of good luck", "Legend says a roasted rooster crowed to prove a condemned man innocent."],
  KR: ["the main royal palace of Seoul", "Built in 1395, it once held over 7,000 rooms; enter in a hanbok and admission is free."],
  CU: ["Cuba's own crocodile", "It is the most aggressive crocodile alive and can leap out of the water to snatch prey from branches."],
  IS: ["Iceland's most active volcano", "Medieval Europeans called it the gateway to hell; it has erupted more than 20 times since 874."],
  UG: ["Uganda's gentle giant", "It shares about 98% of its DNA with you, and half the world's population lives here."],
  IQ: ["the animal of Iraq's Kurdish highlands", "Goats were among the first animals ever tamed, about 10,000 years ago in this region."],
  MA: ["Casablanca's mosque built out over the Atlantic", "Its minaret is 210 metres tall and part of its floor is glass, with the sea beneath."],
  UZ: ["the cat of Uzbekistan's mountains", "It can leap up to nine metres in one bound."],
  GH: ["Ghana's national bird", "Two of them hold up the shield on Ghana's coat of arms."],
  CM: ["Cameroon's own bird", "It lives only in Cameroon's highland forests, and its red feathers go into chiefs' hats."],
  CI: ["the elephant that gave Côte d'Ivoire its name", "The country is named for the ivory trade of the 1400s, and the elephant is on its coat of arms."],
  KP: ["North Korea's winged horse of legend", "It is said to run 1,000 li, about 400 km, in a single day."],
  TW: ["Taiwan's national animal", "It has a white V on its chest and climbs trees to sleep in nests it builds."],
  BF: ["the crane of Burkina Faso's wetlands", "It is the only crane that roosts in trees, thanks to a gripping back toe."],
  RO: ["Romania's 'Dracula's castle'", "Bram Stoker never visited; he found it in a book, and Vlad the Impaler probably never slept here."],
  MW: ["the giant of Malawi's Shire River", "It has the strongest bite ever measured, and a mother carries her hatchlings in her mouth."],
  EC: ["Ecuador's giant of the Galápagos", "It can live over 150 years and go a year without food or water."],
  NL: ["the Dutch lion, on the Netherlands' coat of arms", "The football team is called Oranje, but the lion has been the national symbol since the 1500s."],
  SY: ["Syria's rarest bird", "Ancient Egyptians used it as the hieroglyph for 'brilliance'."],
  GT: ["the sacred cat of the Maya of Guatemala", "Maya kings wore jaguar skins and named their thrones after it."],
  KH: ["Cambodia's temple city, on its flag", "It is the largest religious building on Earth and faces west, unlike most Khmer temples."],
  SN: ["Senegal's fish eagle", "Its feet have spiky scales so slippery fish cannot escape."],
  ZW: ["Zimbabwe's sable", "Its horns sweep back over a metre and it fights off lions with them."],
  GN: ["the chimpanzee of Guinea's forests", "Guinea's chimps use stone hammers to crack nuts, a skill passed down for generations."],
  RW: ["Rwanda's mountain gorilla", "Every year Rwanda holds a naming ceremony for its newborn gorillas."],
  BJ: ["the grey parrot of Benin", "It can learn hundreds of words and understand ideas like 'same' and 'different'."],
  TN: ["Tunisia's desert companion", "It closes its nostrils in sandstorms and has three eyelids."],
  BI: ["Burundi's crane", "Its golden crown is made of stiff feathers; it dances by bowing and leaping."],
  BE: ["Belgium's gentle giant horse", "It is one of the strongest horse breeds; a pair once pulled a 20-tonne load."],
  HT: ["Haiti's national bird", "It nests in old woodpecker holes, and its colours mirror the flag."],
  DO: ["the Dominican Republic's living fossil", "It is one of the few mammals with a venomous bite and has barely changed in 70 million years."],
  CZ: ["the largest ancient castle complex in the world", "It covers 70,000 square metres, and its cathedral took almost 600 years to finish."],
  JO: ["Jordan's national animal", "It was extinct in the wild by 1972 and brought back; seen from the side it may have inspired the unicorn."],
  AZ: ["Azerbaijan's national horse", "Its golden coat shines in the sun; one was gifted to Queen Elizabeth II in 1956."],
  AE: ["Abu Dhabi's mosque of white marble", "Its carpet is the largest hand-knotted carpet in the world, made by 1,200 weavers."],
  HU: ["Budapest's palace on the Danube", "It has 691 rooms and 40 kg of gold on its walls, and the Holy Crown is kept inside."],
  HN: ["Honduras' national animal", "It flashes the white underside of its tail as a warning to the herd."],
  BY: ["Belarus' national animal", "It is Europe's heaviest land animal and was saved from extinction by just 12 zoo animals."],
  TJ: ["the cat of Tajikistan's Pamirs", "Its huge paws work like snowshoes."],
  IL: ["Jerusalem's Great Synagogue", "Its stained-glass windows were shipped from Italy, and it stands on King George Street."],
  AT: ["Austria's highest mountain", "A road built in 1935 winds up to its glacier through 36 hairpin bends."],
  PG: ["Papua New Guinea's kangaroo that lives in trees", "It can leap 9 metres down from a branch to the ground unharmed."],
  CH: ["Switzerland's pyramid peak", "Its shape is on the Toblerone box; four of the first seven climbers died on the way down in 1865."],
  TG: ["Togo's grey parrot", "It mates for life and can live 50 years."],
  SL: ["Sierra Leone's national animal", "The Tacugama sanctuary got the chimp declared the national animal in 2019."],
  LA: ["the elephant of Laos, once called the Land of a Million Elephants", "An elephant's trunk has about 40,000 muscles and no bones."],
  PY: ["Paraguay's national bird", "Its call is one of the loudest bird sounds known, like a hammer on an anvil."],
  BG: ["the stork that returns to Bulgaria every spring", "Bulgarians wear red-and-white martenitsa threads until they see the first stork."],
  RS: ["Serbia's great vulture of the Uvac canyon", "A griffon vulture has been recorded at 11,000 metres, higher than any other bird."],
  LB: ["Lebanon's mountain partridge", "Its name comes from its call: 'chuk-chuk-chukar'."],
  NI: ["Nicaragua's volcano beside Lake Managua", "It erupted in 2015 after 110 years of silence."],
  KG: ["the symbol of Kyrgyzstan", "Its fur is so thick that it can sleep on snow at minus 40."],
  SV: ["El Salvador's 'lighthouse of the Pacific'", "It erupted almost without pause for 196 years, and sailors steered by its glow."],
  ER: ["Eritrea's national animal, on its coat of arms", "Camels carried the goods and even the guns of Eritrea's independence fighters."],
  TM: ["Turkmenistan's golden horse, on its coat of arms", "Its coat has a metallic sheen because its hairs are hollow."],
  DK: ["Denmark's largest wild animal", "A stag's antlers drop off every winter and regrow in summer, up to 1 kg a week."],
  SG: ["Singapore's national bird", "It is tiny, about 10 cm, and hovers at flowers like a hummingbird."],
  FI: ["Finland's national bird", "Its trumpet call carries for kilometres, and it is on the Finnish one-euro coin."],
  SK: ["Slovakia's lynx of the Carpathians", "Its ear tufts help it hear, and it can spot a mouse from 75 metres."],
  CG: ["the Republic of the Congo's gorilla", "A silverback can lift about 800 kg, ten times an adult human."],
  CR: ["Costa Rica's laziest resident", "It moves so slowly that algae grow in its fur, turning it green."],
  OM: ["Oman's fort with the great round tower", "Its tower is 36 metres wide and was built to take cannon fire; holes above the door were for pouring boiling date syrup."],
  IE: ["Ireland's largest wild animal", "The Killarney herd has lived there since the end of the Ice Age."],
  LR: ["Liberia's grey parrot", "One named Alex learned to count and to name colours and shapes."],
  PS: ["Hebron's mosque over the Cave of the Patriarchs", "It stands on foundations laid by Herod about 2,000 years ago."],
  PA: ["Panama's national bird", "Its talons are as long as a bear's claws, and it snatches monkeys from the canopy."],
  KW: ["Kuwait's largest mosque", "Its main hall holds 10,000 worshippers under a 43-metre dome."],
  HR: ["the eagle of Croatia's mountains", "It can dive at over 300 km/h, among the fastest animals on Earth."],
  GE: ["Georgia's church beneath Mount Kazbek", "It sits at 2,170 metres, and treasures from Tbilisi were hidden here in times of danger."],
  UY: ["Uruguay's tero, the national bird", "It defends its nest so fiercely that farmers keep it as a watchdog."],
  BA: ["the eagle of Bosnia's Dinaric Alps", "A pair keeps the same nest for years and may build it 2 metres wide."],
  AM: ["Armenia's monastery carved into the cliff", "Part of it was cut straight into the rock, and it once held the spear said to have pierced Christ."],
  JM: ["Jamaica's largest snake, the yellow snake", "It is harmless to people, squeezes rats and bats, and lives only in Jamaica."],
  AL: ["Albania's eagle, on its flag", "Albanians call their country Shqipëri, 'land of the eagles'."],
  QA: ["Qatar's largest mosque, in Doha", "It holds 30,000 people and has 28 domes."],
  LT: ["Lithuania's national bird", "Lithuania has the densest stork population in Europe; Stork Day is 25 March."],
  MD: ["the wild ox on Moldova's coat of arms", "The real aurochs went extinct in 1627; the last one died in Poland."],
  GM: ["the chimpanzee of the River Gambia", "Chimps rescued from the pet trade have lived free on the river's islands since 1979."],
  GA: ["Gabon's gorilla", "Gorillas rarely drink; they get their water from the plants they eat."],
  LS: ["Lesotho's rhino", "Its horn is made of the same stuff as your fingernails."],
  SI: ["Slovenia's native bee", "Slovenia has more beekeepers per head than any country, and World Bee Day was its idea."],
  MK: ["North Macedonia's rarest animal", "Fewer than 40 remain, in the Mavrovo mountains."],
  GW: ["Guinea-Bissau's grey parrot", "It has been kept as a talking pet since ancient Egypt."],
  LV: ["Latvia's national insect", "A ladybird can eat 50 aphids a day, and its spots do not show its age."],
  XK: ["Kosovo's lynx", "It is so shy that it was only caught on camera in Kosovo for the first time in 2015."],
  BH: ["Bahrain's grand mosque", "Its dome is the largest fibreglass dome in the world."],
  TT: ["Trinidad's nesting giant", "It can weigh 700 kg and dive 1,200 metres deep."],
  GQ: ["Equatorial Guinea's most colourful monkey", "It is the largest monkey alive, and its face gets brighter when it is excited."],
  EE: ["Estonia's national bird", "It flies about 10,000 km to Africa and back every year."],
  TL: ["Timor-Leste's 'grandfather crocodile'", "Legend says the island itself is a crocodile that turned to land."],
  MU: ["the lost bird of Mauritius", "It went extinct by 1681, less than a century after sailors first saw it."],
  CY: ["Cyprus's wild sheep", "It lives only in the Troodos mountains and is on Cypriot euro coins."],
  SZ: ["Eswatini's lion, on its coat of arms", "Lions had vanished from the country until they were brought back in 1994."],
  DJ: ["Djibouti's tiny antelope", "It is the size of a small dog and never needs to drink."],
  FJ: ["Fiji's own iguana", "It turns from bright green to black when it is stressed."],
  KM: ["the Comoros' huge volcano", "Its crater is 3 km wide, one of the largest on Earth."],
  GY: ["Guyana's national animal, on its coat of arms", "It is the only big cat that regularly hunts in water."],
  BT: ["Bhutan's national animal", "Legend says a saint made it by joining a goat's head to a cow's body."],
  SB: ["the giant of the Solomon Islands", "It is the largest reptile alive, up to 6 metres, and swims far out to sea."],
  ME: ["Montenegro's eagle, on its flag", "The double-headed eagle has been the symbol of Montenegrin rulers since the 1400s."],
  LU: ["Luxembourg's castle on the hill", "Victor Hugo lived beneath it in 1871 and sketched it."],
  SR: ["Suriname's jaguar", "It has the strongest bite of any big cat for its size."],
  CV: ["Cabo Verde's volcano", "People farm and make wine inside its crater, and the village there was rebuilt after the 2014 eruption."],
  MV: ["the gentle giant of the Maldives", "It is the largest fish on Earth, and each one has a unique spot pattern like a fingerprint."],
  MT: ["Malta's national dog", "It blushes: its nose and ears turn pink when it is happy."],
  BN: ["Brunei's golden-domed mosque", "Its dome is covered in pure gold, and it stands in a lagoon beside a stone royal barge."],
  BZ: ["Belize's national animal", "It is the largest land mammal of Central America and a fine swimmer."],
  BS: ["the Bahamas' national fish", "It can swim at 80 km/h and grows to 4 metres."],
  VU: ["Vanuatu's volcano you can stand beside", "It has erupted almost continuously for 800 years, and visitors watch from the crater rim."],
  BB: ["Barbados' green monkey", "It came on ships from West Africa 350 years ago, and its fur has a golden-green tint."],
  ST: ["São Tomé's own shrew", "It lives on this one island and nowhere else on Earth."],
  WS: ["Samoa's fruit bat", "It is a bat with a wingspan of about a metre that feeds by day."],
  LC: ["Saint Lucia's national bird", "It was down to about 150 birds in the 1970s and is now over 2,000."],
  KI: ["Kiribati's bird, on its flag", "It can stay in the air for two months without landing."],
  FM: ["Micronesia's sea cow", "It grazes seagrass meadows and may have started the mermaid legend."],
  GD: ["Grenada's monkey", "It arrived from West Africa on ships in the 1700s and stores food in cheek pouches."],
  VC: ["Saint Vincent's volcano", "It erupted in 2021 and covered the island in ash."],
  TO: ["Tonga's visiting giant", "Humpbacks come every winter to give birth, and their songs can travel 30 km underwater."],
  SC: ["the Seychelles' giant tortoise", "One named Jonathan is over 190 years old, the oldest known land animal."],
  AG: ["Antigua's turtle", "Its shell was the original 'tortoiseshell', and it eats sponges that would poison most animals."],
  AD: ["Andorra's mountain goat-antelope", "It can leap 2 metres up and run at 50 km/h on cliffs."],
  DM: ["Dominica's national bird, on its flag", "Dominica's is the only national flag with purple on it, for this parrot."],
  MH: ["the Marshall Islands' turtle", "It returns to the beach where it hatched to lay its own eggs, decades later."],
  KN: ["Saint Kitts' monkey", "There may be more monkeys than people on the island."],
  MC: ["the home of Monaco's ruling family", "The Grimaldis have ruled from it for over 700 years; the guard changes every day at 11:55."],
  LI: ["the home of Liechtenstein's prince", "Every 15 August the prince invites the whole country to a garden party."],
  SM: ["the oldest of San Marino's three towers", "It has stood on Mount Titano since the 11th century and was a prison until 1970."],
  PW: ["Palau's dugong", "It is the only fully vegetarian sea mammal."],
  NR: ["Nauru's giant crab", "It is the largest land crab on Earth and can crack coconuts with its claws."],
  TV: ["Tuvalu's turtle", "It can hold its breath for hours while resting."],
  VA: ["the largest church in the world", "It took 120 years to build, and Michelangelo designed its dome at 71."],
};

const FACE = new Set(['1f43b', '1f43a', '1f98a', '1f428', '1f981']);   // face-only glyphs: take a bird or a place instead when there is one (the panda face is iconic enough)
const KIND_ORDER = ['a', 'b', 'p'];
function pick(a2) {
  if (PLACE[a2]) { const [kind, hex] = PLACE[a2]; return { kind, hex }; }
  const d = disc[a2];
  let best = null;
  const hit = (text, kw) => new RegExp('(^|[^a-z])' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)').test(text);   // whole words: 'ox' must not match 'fox', 'tur' not 'turaco'
  for (const kind of KIND_ORDER) { const text = (d[kind] || '').toLowerCase(); for (const [kw, hex] of RULES) if (hit(text, kw)) { if (!best || (FACE.has(best.hex) && !FACE.has(hex))) best = { kind, hex }; break; } if (best && !FACE.has(best.hex)) break; }
  return best;
}
const boards = {}; const need = new Set();
for (const L of levels) { const p = pick(L.a2); if (!p) throw new Error('no glyph for ' + L.name + ': ' + JSON.stringify(disc[L.a2])); const [rel, fact] = ABOUT[L.a2] || []; if (!rel || !fact) throw new Error('no ABOUT entry for ' + L.a2); boards[L.a2] = { kind: p.kind, hex: p.hex, name: p.kind === 'p' ? (LABEL[L.a2] || short(disc[L.a2].p)) : short(disc[L.a2][p.kind]), rel, fact }; need.add(p.hex); }
if (Object.keys(LABEL).some(a2 => boards[a2]?.kind !== 'p')) throw new Error('LABEL names a country whose board is not a place');
function short(name) { return name.split(/ and | \(|, /)[0].trim(); }   // "Golden eagle (heraldic)" → "Golden eagle"; "Red kangaroo and the koala" → "Red kangaroo"

function scaleFor(d, target, tier) {
  const probe = rasterise(d, 0.3);
  const tall = probe.h > probe.w * 1.5, wide = probe.w > probe.h * 1.5;
  const maxW = wide ? MAX_WIDE_OF[tier] : MAX_DIM_OF[tier], maxH = tall ? MAX_TALL_OF[tier] : MAX_DIM_OF[tier];
  let lo = 0.06, hi = Math.max(maxW, maxH) / REF, best = null;
  for (let i = 0; i < 18; i++) { const k = Math.round((lo + hi) / 2 * 1000) / 1000; const m = rasterise(d, k); if (m.count < target) lo = k; else hi = k; if (m.w <= maxW && m.h <= maxH && (!best || Math.abs(m.count - target) < Math.abs(best.count - target))) best = m; if (hi - lo < 0.0015) break; }
  return best;
}
const shapes = {}; const S = 240;
// potrace writes M/L/C/Z; cubics are sampled into straight runs, then the polyline is thinned (Douglas–Peucker)
function flatten(raw, tol) {
  const toks = raw.match(/[MLCZ]|-?\d+\.?\d*/g); const rings = []; let ring = null, cmd = '', cur = [0, 0], i = 0;
  const num = () => +toks[i++];
  while (i < toks.length) {
    const t = toks[i]; if (/[MLCZ]/.test(t)) { cmd = t; i++; if (t === 'Z') { ring = null; continue; } }
    if (cmd === 'M') { ring = [[num(), num()]]; rings.push(ring); cur = ring[0]; cmd = 'L'; }
    else if (cmd === 'L') { cur = [num(), num()]; ring.push(cur); }
    else if (cmd === 'C') { const [x1, y1, x2, y2, x, y] = [num(), num(), num(), num(), num(), num()]; const [x0, y0] = cur; for (let s = 1; s <= 4; s++) { const u = s / 4, v = 1 - u; ring.push([v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x, v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y]); } cur = [x, y]; }
    else throw new Error('unexpected path token ' + t);
  }
  const dist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy || 1; const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy); };
  const rdp = pts => { if (pts.length < 3) return pts; let far = 0, at = 0; for (let k = 1; k < pts.length - 1; k++) { const d = dist(pts[k], pts[0], pts[pts.length - 1]); if (d > far) { far = d; at = k; } } return far > tol ? rdp(pts.slice(0, at + 1)).slice(0, -1).concat(rdp(pts.slice(at))) : [pts[0], pts[pts.length - 1]]; };
  return rings.map(r => { if (r.length > 1 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 1e-6) r = r.slice(0, -1); const half = Math.ceil(r.length / 2); return rdp(r.slice(0, half + 1)).slice(0, -1).concat(rdp(r.slice(half).concat([r[0]])).slice(0, -1)); }).filter(r => r.length >= 3);
}
function fit(rings) {   // scale into the REF box, centred, one decimal
  const xs = rings.flat().map(p => p[0]), ys = rings.flat().map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), sc = REF / Math.max(x1 - x0, y1 - y0);
  const ox = (REF - (x1 - x0) * sc) / 2, oy = (REF - (y1 - y0) * sc) / 2;
  const f = v => String(Math.round(v * 10) / 10);
  return rings.map(r => 'M ' + r.map(([x, y]) => `${f((x - x0) * sc + ox)} ${f((y - y0) * sc + oy)}`).join(' L ') + ' Z').join(' ');
}
for (const hex of need) {
  if (CUSTOM[hex]) { const d = CUSTOM[hex]; const masks = TARGETS.map((t, tier) => scaleFor(d, t, tier)); shapes[hex] = { d, k: masks.map(m => m.k) }; console.log(hex, 'custom', masks.map(m => `${m.count} ${m.w}x${m.h}`).join(' | ')); continue; }
  const file = TW + hex + '.svg'; if (!fs.existsSync(file)) throw new Error('no twemoji ' + hex);
  const png = await sharp(fs.readFileSync(file)).resize(S, S, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().extractChannel('alpha').negate().png().toBuffer();
  const raw = await new Promise((res, rej) => potrace.trace(png, { threshold: 128, turdSize: 14, alphaMax: 1, optTolerance: 0.45 }, (err, out) => err ? rej(err) : res(/ d="([^"]+)"/.exec(out)[1])));
  const d = fit(flatten(raw, 0.9));   // 0.9 px of 240: well under a cell even on Master boards
  const masks = TARGETS.map((t, tier) => scaleFor(d, t, tier));
  if (masks.some(m => !m || m.count < 40)) throw new Error('shape too thin: ' + hex + ' ' + masks.map(m => m && m.count));
  shapes[hex] = { d, k: masks.map(m => m.k) };
  console.log(hex, 'path', d.length, 'cells', masks.map(m => `${m.count} ${m.w}x${m.h}`).join(' | '));
}
fs.writeFileSync(OUT, JSON.stringify({ version: 2, shapes, boards }));
console.log(Object.keys(shapes).length, 'shapes for', Object.keys(boards).length, 'countries, bytes', fs.statSync(OUT).size);
const byHex = {}; for (const [a2, b] of Object.entries(boards)) (byHex[b.hex] = byHex[b.hex] || []).push(a2 + ':' + b.kind);
console.log(JSON.stringify(byHex));
