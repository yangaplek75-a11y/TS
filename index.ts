import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = "https://cdn.moltyroyale.com/api";
const TURN_DELAY = 60 * 1000;

// =========================================================================
// 📂 MEMBACA DAFTAR BOT DARI FILE bots_config.json
// =========================================================================
let DAFTAR_BOT: { name: string, apiKey: string }[] = [];
try {
    const configPath = path.join(__dirname, 'bots_config.json');
    const rawData = fs.readFileSync(configPath, 'utf-8');
    DAFTAR_BOT = JSON.parse(rawData);
    console.log(`✅ Berhasil memuat ${DAFTAR_BOT.length} bot dari bots_config.json`);
} catch (error) {
    console.error("❌ GAGAL MEMBACA bots_config.json! Pastikan file ada dan formatnya benar.");
    process.exit(1);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const randomFloat = (min: number, max: number) => Math.random() * (max - min) + min;
const randomChoice = (arr: any[]) => arr[Math.floor(Math.random() * arr.length)];
const getWaktu = () => new Date().toTimeString().split(' ')[0];

// ================== FUNGSI DETEKSI & LOGIC PYTHON ==================
function ekstrakInfoItem(item: any): [string | null, string] {
    if (typeof item === 'string' || typeof item === 'number') return [String(item), "Barang Misterius"];
    if (typeof item === 'object' && item !== null) {
        let id = item.id || item._id || item.itemId || item.uid;
        let name = item.name || item.typeId || "Loot";
        if (item.item && typeof item.item === 'object') {
            const asli = item.item;
            if (!name || name === "Loot") name = asli.name || asli.typeId || "Barang";
            if (!id) id = asli.id;
        }
        if (!id) {
            for (const [k, v] of Object.entries(item)) {
                if (typeof v === 'string' && v.length > 10 && !["name", "type", "description", "regionId"].includes(k)) {
                    id = v; break;
                }
            }
        }
        return [id ? String(id) : null, String(name)];
    }
    return [null, "Barang Misterius"];
}

function isValidWeapon(itemName: string, itemData: any): boolean {
    const nl = String(itemName).toLowerCase();
    const blacklist = ["fist", "none", "bandage", "medkit", "ration", "potion", "moltz", "coin", "emergency", "megaphone", "radio", "map"];
    for (const word of blacklist) if (nl.includes(word)) return false;

    if (itemData && typeof itemData === 'object') {
        const iData = itemData.item || itemData;
        if (iData && typeof iData === 'object') {
            const itemType = String(iData.type || "").toLowerCase();
            if (itemType && !itemType.includes("weapon")) return false;
        }
    }
    const weapons = ["sniper", "rifle", "katana", "pistol", "gun", "sword", "bow", "knife", "dagger"];
    for (const w of weapons) if (nl.includes(w)) return true;
    return false;
}

function getWeaponScore(weaponName: string): number {
    const nl = String(weaponName).toLowerCase();
    if (nl.includes("fist") || nl.includes("none")) return 0;
    if (nl.includes("sniper") || nl.includes("rifle")) return 60;
    if (nl.includes("katana")) return 50;
    if (nl.includes("pistol") || nl.includes("gun")) return 40;
    if (nl.includes("sword")) return 30;
    if (nl.includes("bow")) return 20;
    if (nl.includes("knife") || nl.includes("dagger")) return 10;
    return 5;
}

function sortLootPriority(itemData: any): number {
    const [, name] = ekstrakInfoItem(itemData);
    const nl = String(name).toLowerCase();
    if (nl.includes("moltz") || nl.includes("coin")) return 999;
    if (["medkit", "bandage", "emergency"].some(w => nl.includes(w))) return 100;
    if (["sniper", "katana", "rifle"].some(w => nl.includes(w))) return 80;
    if (["ration", "potion"].some(w => nl.includes(w))) return 50;
    return 10;
}

function cariPintuStrategis(pintuAman: string[], regionDict: any, hpSekarat: boolean): string | null {
    if (!pintuAman || pintuAman.length === 0) return null;
    let ruins: string[] = [];
    let forests: string[] = [];

    for (const rid of pintuAman) {
        const terrain = String(regionDict[rid.toLowerCase()]?.terrain || "").toLowerCase();
        if (terrain.includes("ruins")) ruins.push(rid);
        else if (terrain.includes("forest")) forests.push(rid);
    }

    if (hpSekarat && forests.length > 0) return randomChoice(forests);
    if (!hpSekarat && ruins.length > 0) return randomChoice(ruins);
    return randomChoice(pintuAman);
}

// ================== MESIN UTAMA SETIAP BOT ==================
async function jalankanSatuBot(botConfig: { name: string, apiKey: string }) {
    const BOT_NAME = botConfig.name;
    const HEADERS = { "Content-Type": "application/json", "X-API-Key": botConfig.apiKey };
    const safeName = BOT_NAME.replace(/[^a-zA-Z0-9_]/g, '');
    const SESSION_FILE = `session_${safeName}.json`;

    let mem = {
        visited_path: [] as string[], dz_memory: new Set<string>(), pdz_memory: new Set<string>(),
        sampah_memory: new Set<string>(), last_region_id: null as string | null,
        group1_cd_end: 0, last_log_msg: "", last_print_time: 0
    };

    const smartPrint = (msg: string) => {
        if (mem.last_log_msg !== msg) {
            console.log(`[${getWaktu()}] ${msg}`);
            mem.last_log_msg = msg;
        }
    };

    const apiReq = async (method: string, endpoint: string, payload: any = null) => {
        try {
            return await axios({ method, url: `${BASE_URL}${endpoint}`, data: payload, headers: HEADERS, timeout: 10000 });
        } catch (e: any) {
            return e.response || null;
        }
    };

    const decideAction = (state: any): any => {
        const selfData = state.self || {};
        const myHp = parseInt(selfData.hp) || 100;
        const myId = selfData.id;
        const reg = state.currentRegion || {};
        const curRId = String(reg.id).toLowerCase();
        const visReg = state.visibleRegions || [];

        let adjReg = state.connectedRegions || reg.connections || state.visibleRegions || [];
        let adjIds = adjReg.map((r: any) => String(r.id || r).toLowerCase());

        let regDict: any = {};
        [...visReg, ...(state.connectedRegions || []), reg].forEach((r: any) => {
            if (r && typeof r === 'object' && r.id) regDict[String(r.id).toLowerCase()] = r;
        });

        const allPdz = [...(state.pendingDeathzones || []), ...(state.pendingDeathZones || []), ...(state.game?.pendingDeathzones || [])];
        const allDz = [...(state.deathzones || []), ...(state.deathZones || []), ...(state.game?.deathzones || [])];
        allPdz.forEach(z => mem.pdz_memory.add(String(z.id || z).toLowerCase()));
        allDz.forEach(z => mem.dz_memory.add(String(z.id || z).toLowerCase()));

        const isDzNow = mem.dz_memory.has(curRId) || reg.isDeathZone || reg.isDeathzone;
        const isPdzNow = mem.pdz_memory.has(curRId) || reg.isPendingDeathZone || reg.isPendingDeathzone;

        let idMed = null, idSup = null;
        (reg.interactables || []).forEach((f: any) => {
            if (!f.isUsed) {
                const fn = String(f.name).toLowerCase();
                if (fn.includes("medical")) idMed = f.id;
                else if (fn.includes("supply")) idSup = f.id;
            }
        });

        let inv = selfData.inventory || [];
        let idPotion = null, idBandage = null;
        let tgnKosong = true, wRange = 0, eqScore = 0, eqName = "Tangan Kosong";
        let bestInvWId = null, bestInvWScore = -1, bestInvWName = null;
        let pMega = false, pRad = false, pMap = false;

        let eqItem = selfData.equippedWeapon || selfData.weapon;
        if (eqItem) {
            const [, nmRaw] = ekstrakInfoItem(eqItem);
            const nl = nmRaw.toLowerCase();
            if (!nl.includes("fist") && !nl.includes("none")) {
                tgnKosong = false; eqName = nmRaw; eqScore = getWeaponScore(nmRaw);
                if (["bow", "pistol", "sniper", "rifle", "gun"].some(w => nl.includes(w))) wRange = 1;
            }
        }

        inv.forEach((item: any) => {
            let isEq = typeof item === 'object' && item.isEquipped;
            let [iId, iNm] = ekstrakInfoItem(item);
            let nl = String(iNm).toLowerCase();

            if (nl.includes("megaphone")) pMega = true;
            if (nl.includes("radio")) pRad = true;
            if (nl.includes("map")) pMap = true;

            if (isEq) {
                if (!nl.includes("fist") && !nl.includes("none")) {
                    tgnKosong = false; eqName = iNm; eqScore = getWeaponScore(iNm);
                    if (["bow", "pistol", "sniper", "rifle", "gun"].some(w => nl.includes(w))) wRange = 1;
                }
                return;
            }

            if (["bandage", "medkit", "emergency"].some(w => nl.includes(w))) idBandage = idBandage || iId;
            else if (["ration", "potion"].some(w => nl.includes(w))) idPotion = idPotion || iId;

            if (isValidWeapon(iNm, item)) {
                let sc = getWeaponScore(iNm);
                if (sc > bestInvWScore) { bestInvWScore = sc; bestInvWId = iId; bestInvWName = iNm; }
            }
        });

        let mPlay: any[] = [], mMon: any[] = [], fPlay: any[] = [];
        let allPpl = [...(state.visibleAgents || []), ...(state.visibleNpcs || []), ...(state.visibleMonsters || []), ...(state.monsters || []), ...(reg.npcs || []), ...(reg.monsters || [])];

        allPpl.forEach((a: any) => {
            if (a.isAlive && a.id !== myId) {
                let mRegId = String(a.regionId).toLowerCase();
                let jarak = (mRegId === curRId) ? 0 : (adjIds.includes(mRegId) ? 1 : 99);
                if (jarak <= Math.max(wRange, 1)) {
                    a.jarak = jarak;
                    let nm = String(a.name).toLowerCase();
                    let isMon = ["monster", "npc"].includes(a.type) || ["wolf", "bear", "bandit"].some(w => nm.includes(w));
                    if (nm.includes("peaxel")) fPlay.push(a);
                    else if (isMon) mMon.push(a);
                    else mPlay.push(a);
                }
            }
        });

        mPlay.sort((a, b) => (a.hp || 100) - (b.hp || 100));
        mMon.sort((a, b) => (a.hp || 100) - (b.hp || 100));
        let tPlay = mPlay[0] || null;
        let tMon = mMon[0] || null;
        let nPlay = mPlay.filter(m => m.jarak === 0).length;
        let kekuatan = 1 + fPlay.filter(t => t.jarak === 0).length;

        let brgTanah = [...(state.visibleItems || []), ...(reg.items || []), ...(state.items || []), ...(state.droppedItems || [])];
        brgTanah.sort((a, b) => sortLootPriority(b) - sortLootPriority(a));

        const aMov = (msg: string) => {
            if (!adjReg.length) return null;
            let pAman: string[] = [], pBlind: string[] = [], pPend: string[] = [];

            adjReg.forEach((r: any) => {
                let rId = r.id || r;
                if (!rId) return;
                let srId = String(rId).toLowerCase();
                let rObj = regDict[srId] || {};
                let idz = mem.dz_memory.has(srId) || rObj.isDeathZone || rObj.isDeathzone;
                let ipdz = mem.pdz_memory.has(srId) || rObj.isPendingDeathZone || rObj.isPendingDeathzone;
                if (!idz) {
                    if (ipdz) pPend.push(rId);
                    else if (Object.keys(rObj).length > 0) pAman.push(rId);
                    else pBlind.push(rId);
                }
            });

            let tId = null;
            if (pAman.length > 0) {
                let pBaru = pAman.filter(r => !mem.visited_path.includes(r));
                if (pBaru.length > 0) tId = cariPintuStrategis(pBaru, regDict, myHp < 60);
                else {
                    let rSeb = mem.visited_path.length > 0 ? mem.visited_path[mem.visited_path.length - 1] : null;
                    let pDar = pAman.filter(r => r !== rSeb);
                    tId = cariPintuStrategis(pDar.length > 0 ? pDar : pAman, regDict, myHp < 60);
                }
                smartPrint(`[${BOT_NAME}] 🏃 ${msg}`);
            } else if (pBlind.length > 0) { tId = randomChoice(pBlind); smartPrint(`[${BOT_NAME}] 🏃 ${msg}`); }
            else if (pPend.length > 0) { tId = randomChoice(pPend); smartPrint(`[${BOT_NAME}] 🏃 ${msg}`); }

            if (tId) {
                mem.visited_path = mem.visited_path.filter(p => p !== tId);
                mem.visited_path.push(tId);
                if (mem.visited_path.length > 20) mem.visited_path.shift();
                return { type: "move", regionId: tId };
            }
            return null;
        };

        if (bestInvWId && (tgnKosong || bestInvWScore > eqScore)) {
            smartPrint(`[${BOT_NAME}] ✨ UPGRADE SENJATA! Pakai [${bestInvWName}]!`);
            return { type: "equip", itemId: bestInvWId };
        }

        let maxSc = Math.max(eqScore, bestInvWScore);
        for (const item of inv) {
            let isEq = typeof item === 'object' && item.isEquipped;
            if (!isEq) {
                let [iId, iNm] = ekstrakInfoItem(item);
                if (iId && mem.sampah_memory.has(iId)) continue;
                if (isValidWeapon(iNm, item) && getWeaponScore(iNm) < maxSc) {
                    mem.sampah_memory.add(iId!);
                    smartPrint(`[${BOT_NAME}] 🗑️ AUTO-CLEAN: Buang ${iNm} usang!`);
                    return { type: "drop", itemId: iId };
                }
            }
        }

        if (brgTanah.length > 0) {
            if (tgnKosong) {
                for (const b of brgTanah) {
                    let [bId, bNm] = ekstrakInfoItem(b);
                    if (isValidWeapon(bNm, b)) {
                        smartPrint(`[${BOT_NAME}] 🚨 DARURAT SENJATA! Sikat ${bNm}!`);
                        return { type: "pickup", itemId: bId };
                    }
                }
            }

            for (const b of brgTanah) {
                let [bId, bNm] = ekstrakInfoItem(b);
                let nl = bNm.toLowerCase();
                if (nl.includes("megaphone") && pMega) continue;
                if (nl.includes("radio") && pRad) continue;
                if (nl.includes("map") && pMap) continue;

                let isKoin = nl.includes("moltz") || nl.includes("coin");
                if (isKoin) {
                    smartPrint(`[${BOT_NAME}] 💰 MATA DUITAN! Ada ${bNm}, SIKAT!`);
                    return { type: "pickup", itemId: bId };
                }
                if (inv.length < 10) {
                    smartPrint(`[${BOT_NAME}] 🎒 Ambil Barang: ${bNm}!`);
                    return { type: "pickup", itemId: bId };
                }
            }
        }

        if (Date.now() < mem.group1_cd_end) return { type: "WAITING_CD" };

        let isTrap = false;
        if (isDzNow || isPdzNow) {
            let a = aMov("🚨 ZONA MERAH! Evakuasi Segera!");
            if (a) return a; else isTrap = true;
        }

        let bHeal = isTrap ? 95 : 80;
        if (myHp < bHeal) {
            if (idMed) { smartPrint(`[${BOT_NAME}] 🏥 Pakai Medical!`); return { type: "interact", interactableId: idMed }; }
            if (idBandage) { smartPrint(`[${BOT_NAME}] 🚑 Suntik Obat! (HP:${myHp})`); return { type: "use_item", itemId: idBandage }; }
            if (idPotion) { smartPrint(`[${BOT_NAME}] 🚑 Minum Potion! (HP:${myHp})`); return { type: "use_item", itemId: idPotion }; }
        }

        if (nPlay >= 3 && nPlay > kekuatan) {
            let a = aMov(`🚨 Musuh ${nPlay}, geng ${kekuatan}. KABUR!`);
            if (a) return a; else smartPrint(`[${BOT_NAME}] 🛑 ZONA AKHIR BUNTU! TAWURAN SINI KAU!`);
        }
        if (nPlay >= 2 && nPlay > kekuatan && myHp < 75) {
            let a = aMov("🚨 Kalah jumlah geng & HP Bocor! Mundur!");
            if (a) return a;
        }

        if (tPlay) {
            let eHp = tPlay.hp || 100, eNm = tPlay.name || "Player";
            if (tgnKosong) {
                let a = aMov("Tangan kosong! Lari cari senjata!");
                if (a) return a; return { type: "attack", targetId: tPlay.id, targetType: "agent" };
            }
            if (tPlay.jarak === 0) {
                if (kekuatan > 1) { smartPrint(`[${BOT_NAME}] 🤝 GANKING MAFIA! Hajar ${eNm}!`); return { type: "attack", targetId: tPlay.id, targetType: "agent" }; }
                if (eHp <= 40) { smartPrint(`[${BOT_NAME}] 🦅 VULTURE MODE! Nyampah kill ${eNm} (HP:${eHp})!`); return { type: "attack", targetId: tPlay.id, targetType: "agent" }; }
                if (myHp > 85 || eHp <= myHp) { smartPrint(`[${BOT_NAME}] ⚔️ Eksekusi ${eNm} (HP:${eHp})!`); return { type: "attack", targetId: tPlay.id, targetType: "agent" }; }
                let a = aMov(`⚠️ ${eNm} sehat (HP:${eHp}). Melipir ah!`);
                if (a) return a;
                smartPrint(`[${BOT_NAME}] ⚔️ Mentok! Duel lawan ${eNm}!`); return { type: "attack", targetId: tPlay.id, targetType: "agent" };
            } else if (tPlay.jarak > 0) {
                if (wRange > 0) { smartPrint(`[${BOT_NAME}] 🎯 SNIPER! Tembak ${eNm} dari jauh!`); return { type: "attack", targetId: tPlay.id, targetType: "agent" }; }
                if (eHp <= 30 && myHp > 70) {
                    smartPrint(`[${BOT_NAME}] 🏃‍♂️ Kejar ${eNm} yg sekarat!`);
                    let trId = String(tPlay.regionId).toLowerCase();
                    mem.visited_path = mem.visited_path.filter(p => p !== trId);
                    mem.visited_path.push(trId);
                    return { type: "move", regionId: trId };
                }
            }
        }

        if (tMon && !tgnKosong && myHp >= 80) {
            let mNm = tMon.name || "Monster";
            if (tMon.jarak > 0 && wRange === 0) {
                smartPrint(`[${BOT_NAME}] 🏃‍♂️ Cari ${mNm} buat farming koin!`);
                return { type: "move", regionId: String(tMon.regionId).toLowerCase() };
            } else {
                smartPrint(`[${BOT_NAME}] 👹 Bantai ${mNm} buat Koin!`);
                return { type: "attack", targetId: tMon.id, targetType: "monster" };
            }
        }

        if (idSup) { smartPrint(`[${BOT_NAME}] 📦 Maling kotak Supply Cache!`); return { type: "interact", interactableId: idSup }; }

        let actMove = aMov("🕵️ Patroli cari duit & tempat aman...");
        if (actMove) return actMove;

        return { type: "explore" };
    };

    while (true) {
        if (botConfig.apiKey === "KOSONG" || botConfig.apiKey.includes("ISI_")) {
            console.log(`❌ [${BOT_NAME}] API KEY BELUM DIISI DI bots_config.json!`);
            break;
        }

        // 🔥 DEKLARASI AMAN BIAR GAK ERROR TS2304 🔥
        let gid: string | null = null;
        let aid: string | null = null;

        if (fs.existsSync(SESSION_FILE)) {
            try {
                let d = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
                let st = await apiReq('GET', `/games/${d.game_id}/agents/${d.agent_id}/state`);
                if (st && st.data?.success && st.data.data?.self?.isAlive && !["finished", "cancelled"].includes(String(st.data.data.gameStatus).toLowerCase())) {
                    console.log(`🔄 [${getWaktu()}] [${BOT_NAME}] RECONNECT BERHASIL!`);
                    gid = d.game_id; aid = d.agent_id;
                } else fs.unlinkSync(SESSION_FILE);
            } catch (e) { }
        }

        // 🔥 LOGIC RADAR "SEDOT SEMUA DATA" 🔥
        let res = await apiReq('GET', '/games?status=waiting');
            
            let listRoom: any[] = [];
            if (res && res.data) {
                if (Array.isArray(res.data.data)) listRoom = res.data.data;
                else if (Array.isArray(res.data)) listRoom = res.data;
                else if (res.data.games && Array.isArray(res.data.games)) listRoom = res.data.games;
            }

            scanCount++;
            if (scanCount % 15 === 0) { 
                console.log(`📡 [${getWaktu()}] [${BOT_NAME}] Radar: Nemu ${listRoom.length} total room, nyari yg gratis...`);
                if (listRoom.length === 0 && res?.data) {
                    console.log(`🔍 [DEBUG ${BOT_NAME}] Data server:`, JSON.stringify(res.data).substring(0, 150));
                }
            }

            let foundGid = null;
            if (listRoom.length > 0) {
                for (let i = listRoom.length - 1; i >= 0; i--) {
                    let g = listRoom[i];
                    let sStatus = String(g?.status || "").toLowerCase();
                    let sType = String(g?.entryType || "").toLowerCase();
                    
                    if (sStatus === "waiting" && sType !== "paid" && !(g?.fee > 0)) {
                        foundGid = g.id || g._id;
                        break;
                    }
                }
            }

            if (foundGid) {
                console.log(`🧾 [${getWaktu()}] [${BOT_NAME}] Nemu Room (${String(foundGid).slice(-5)}). Dobrak pintu!`);
                let regRes = await apiReq('POST', `/games/${foundGid}/agents/register`, { name: BOT_NAME });

                if (regRes && (regRes.data?.success || regRes.data?.id)) {
                    aid = regRes.data?.data?.id || regRes.data?.id;
                    gid = foundGid; // Setel gid setelah sukses
                    console.log(`✅ [${getWaktu()}] [${BOT_NAME}] BERHASIL MASUK! (Agent ID: ${String(aid).slice(-5)})`);
                    fs.writeFileSync(SESSION_FILE, JSON.stringify({ game_id: gid, agent_id: aid }));
                    
                    apiReq('POST', `/games/${gid}/start`); 
                } else {
                    let err = regRes?.data?.message || regRes?.data?.error || "Room udah diembat orang";
                    console.log(`⚠️ [${BOT_NAME}] Gagal dobrak: ${err}`);
                }
            }

            if (!aid) {
                await sleep(randomFloat(500, 1500));
            }
        }

        // 🔥 LOOP DALAM GAME 🔥
        while (true) {
            if (!gid || !aid) break; // Safety check ekstra
            
            let stRes = await apiReq('GET', `/games/${gid}/agents/${aid}/state`);
            if (!stRes || [400, 403, 404].includes(stRes.status)) {
                if (fs.existsSync(SESSION_FILE)) { try { fs.unlinkSync(SESSION_FILE); } catch(e){} }
                break;
            }
            let state = stRes.data?.data;
            if (!state) { await sleep(1000); continue; }

            if (!state.self?.isAlive) {
                console.log(`\n💀 [${BOT_NAME}] MATI! TKP: ${state.currentRegion?.name || '?'}`);
                if (fs.existsSync(SESSION_FILE)) { try { fs.unlinkSync(SESSION_FILE); } catch(e){} }
                await sleep(3000); break;
            }
            if (state.gameStatus === "finished") {
                console.log(`\n🏁 [${BOT_NAME}] MATCH SELESAI!`);
                if (fs.existsSync(SESSION_FILE)) { try { fs.unlinkSync(SESSION_FILE); } catch(e){} }
                await sleep(3000); break;
            }

            if (Date.now() - mem.last_print_time >= 20000) {
                let hp = state.self.hp || "?", tas = (state.self.inventory || []).length, loc = state.currentRegion?.name || "?";
                let eqItem = state.self.equippedWeapon || state.self.weapon;
                let wpInfo = "Tangan Kosong 👊";
                if (eqItem) {
                    let [, n] = ekstrakInfoItem(eqItem);
                    if (!n.toLowerCase().includes("fist") && !n.toLowerCase().includes("none")) wpInfo = `${n} 🗡️`;
                }
                console.log(`\n[🎮 GAME ${String(gid).slice(-5)}] [${BOT_NAME}] | HP:${hp} | Tas:${tas}/10 | Senj: ${wpInfo} | Loc:${loc}`);
                mem.last_print_time = Date.now();
                mem.last_log_msg = "";
            }

            let action = decideAction(state);
            if (action) {
                if (action.type === "WAITING_CD") { await sleep(1500); continue; }
                let actRes = await apiReq('POST', `/games/${gid}/agents/${aid}/action`, { action });
                if (actRes && actRes.data?.success) {
                    mem.group1_cd_end = Date.now() + (["pickup", "equip", "drop"].includes(action.type) ? 300 : TURN_DELAY);
                    await sleep(1000);
                } else {
                    let err = String(actRes?.data?.error?.message || "").toLowerCase();
                    if (!err.includes("cooldown")) console.log(`⚠️ [${BOT_NAME}] Nolak aksi: ${err}`);
                    await sleep(1000);
                }
            } else await sleep(1000);
        }
    }
}

// =========================================================================
// 🚀 EKSEKUTOR (JALANIN BOT PARALEL - RAM SUPER IRIT)
// =========================================================================
async function main() {
    console.log("=============================================");
    console.log(" 🏭 KARTEL PEAXEL TYPESCRIPT FACTORY START 🏭");
    console.log("=============================================");

    if (DAFTAR_BOT.length === 0) {
        console.error("❌ TIDAK ADA BOT YANG BERJALAN! Cek isi bots_config.json");
        return;
    }

    const botPromises = DAFTAR_BOT.map(botConfig => {
        return sleep(randomFloat(1000, 5000)).then(() => jalankanSatuBot(botConfig));
    });

    await Promise.all(botPromises);
}

main();

