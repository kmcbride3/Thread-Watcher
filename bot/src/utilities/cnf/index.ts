import {stringify, parse as j5Parse} from "json5"
import { join } from "path"
import { existsSync, renameSync, readFileSync, writeFileSync } from "fs"
import { validateValue } from "./defaults"

const P_J5 = join(__dirname, "../../../config.json5")
const P_FBJ5 = join(__dirname, "../../../_config.json5")
const P_TS = join(__dirname, "../../config.js")

interface DbOptions {
    user: string,
    password: string,
    host: string,
    port: number,
    database: string,
    dataLocation: string
}

interface BotStyle {
    colour: string,
    emoji: string,
}

export interface ConfigFile {
    tokens: { discord: string, topgg: string },
    clientID: string,
    database: { type: "sqlite"|"mysql", options: DbOptions, backupInterval: string, backupAmount: number, backupProvider: "none"|"discord" },
    statsServer: { enabled: boolean, port: number },
    style: { error: BotStyle, success: BotStyle, info: BotStyle, warning: BotStyle },
    owners: string[],
    devServer: string,
    devServerInvite: string,
    logWebhook?: string,
    logLevel: "NONE" | "ERROR" | "WARN" | "INFO" | "DEBUG",
    logToFile: boolean
}

const parse = async () => {
    const { default: deprecatedFile } = await import(P_TS)
    if(!deprecatedFile) {
        console.log("Could not find old config")
        return
    }
    const oldConf = deprecatedFile as ConfigFile

    if(!oldConf.database.type) {
        console.warn("Database type has been set to 'sqlite' by default. If you previously used 'mysql', please update the 'database.type' field in the configuration file to 'mysql' and provide the necessary connection details.")
    }

    // Default dataLocation to "./" as most users use sqlite
    // and that is where the old data file will have been placed
    oldConf.database.options.dataLocation = "./"

    writeFileSync(P_J5, stringify(oldConf, null, 3))
}

const ensureFile = () => {
    const j5CnfExists = existsSync(P_J5)
    const j5FallBackExists = existsSync(P_FBJ5)
    const tsCnfExists = existsSync(P_TS)

    if(j5CnfExists) return

    if(!j5CnfExists && !j5FallBackExists && !tsCnfExists) {
        console.error("No config exists.\nCopy the contents of https://github.com/ffamilyfriendly/Thread-Watcher/blob/main/bot/_config.json5 into a file called \"config.json5\" in the bot folder located at 'bot/config.json5'.")
        process.exit(1)
    }

    if(tsCnfExists) {
        console.log("Old config found! Trying to parse...")
        parse()
        return
    }
    
    if(j5FallBackExists) {
        console.log("Moving config file:\n_config.json5 -> config.json5")
        renameSync(P_FBJ5, P_J5)
        return
    }
}

export default function (): ConfigFile {
    ensureFile();
    const reviver = (key: string, value: unknown) => validateValue(key, value)
    try {
        const config = j5Parse(readFileSync(P_J5, "utf-8"), reviver) as ConfigFile
        if (!config.logLevel) {
            config.logLevel = "INFO";
        }
        return config
    } catch (error) {
        console.error("Error reading the config file:", error)
        process.exit(1)
    }
}
