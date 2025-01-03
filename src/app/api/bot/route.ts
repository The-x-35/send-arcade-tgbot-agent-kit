export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 300;

import { Bot, webhookCallback } from 'grammy';
import { SolanaAgentKit } from "../../../app/solana-agent-kit";
import { createSolanaTools } from "../../../app/solana-agent-kit/langchain";
import { ChatOpenAI } from "@langchain/openai";
import * as fs from "fs";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import { getApps, initializeApp, getApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { Keypair } from '@solana/web3.js';
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN environment variable not found.');
const bot = new Bot(token);

const checkpointer = PostgresSaver.fromConnString(
  process.env.POSTGRES_GCP_LINK!,
);

// Firebase
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

// Initialize Firebase
const app = !getApps.length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

async function getOrCreateUserKeyPair(userId: string) {
  const userDocRef = doc(db, 'users', userId);
  const userDocSnap = await getDoc(userDocRef);

  if (userDocSnap.exists()) {
    // Return existing key pair
    return userDocSnap.data();
  }

  // Generate a new key pair
  const keypair = Keypair.generate();
  const keypairData = {
    publicKey: keypair.publicKey.toString(),
    privateKey: String(bs58.encode(keypair.secretKey)),
    inProgress: false,
    inGame: false,
  };

  // Store in Firebase
  await setDoc(userDocRef, keypairData);

  return keypairData;
}

const WALLET_DATA_FILE = "wallet_data.txt";

async function initializeAgent(userId: string, keyPair: any) {
  try {
    const llm = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0.7,
    });

    let walletDataStr: string | null = null;

    if (fs.existsSync(WALLET_DATA_FILE)) {
      try {
        walletDataStr = fs.readFileSync(WALLET_DATA_FILE, "utf8");
      } catch (error) {
        console.error("Error reading wallet data:", error);
      }
    }

    const solanaKit = new SolanaAgentKit(
      keyPair.privateKey,
      process.env.RPC_URL,
      process.env.OPENAI_API_KEY!
    );

    const tools = createSolanaTools(solanaKit);
    await checkpointer.setup();
    const config = { configurable: { thread_id: userId } };
    const agent = createReactAgent({
      llm,
      tools,
      checkpointSaver: checkpointer,
      messageModifier: `
        You are a helpful Send Arcade agent that can interact onchain using the Solana Agent Kit. You are 
        empowered to interact onchain using your tools. If you ever need funds, you can request them from the 
        user at ${keyPair.publicKey}. If not, you can provide your wallet details and request funds from the user. If there is a 5XX 
        (internal) HTTP error code, ask the user to try again later. If someone asks you to do something you 
        can't do with your currently available tools, you must say so, and encourage them to implement it 
        themselves using the Solana Agent Kit, recommend they go to https://sendai.fun/kit for more information. Be 
        concise and helpful with your responses. Refrain from restating your tools' descriptions unless it is 
        explicitly requested. Do not send any formatting in the response. You can
         - Check wallet balances.
         - Transfer tokens or SOL.
         - Deploy new tokens and NFT collections.
         - Mint NFTs.
         - Swap tokens.
         - Stake SOL.
         - Request funds from a faucet (for testnet/devnet).
         - Fetch token prices.
         - Manage liquidity pools and market interactions.
         - Play games like rock-paper-scissors. 
         and more
      `,
    });

    if (walletDataStr) {
      fs.writeFileSync(WALLET_DATA_FILE, walletDataStr);
    }

    return { agent, config };
  } catch (error) {
    console.error("Failed to initialize agent:", error);
    throw error;
  }
}
let agent: { stream: (arg0: { messages: HumanMessage[]; }, arg1: any) => any; }, config: any;
// Telegram bot handler
bot.on('message:text', async (ctx) => {
  // await ctx.reply("I'm sorry, I'm not able to process your request at the moment. Please try again later.");
  // return;
  const userId = ctx.from?.id.toString();
  if (!userId) return;
  const userDocRef = doc(db, 'users', userId);
  const userDocSnap = await getDoc(userDocRef);

  if (!userDocSnap.exists()) {
    // Get or create user key pair
    const codeDocRef = doc(db, 'inviteCodes', ctx.message.text);
    const codeDocSnap = await getDoc(codeDocRef);
    if (!codeDocSnap.exists()) {
      await ctx.reply(`Invalid invite code. Please try again.`);
      return;
    }
    const data = await getDoc(codeDocRef);
    const codeData = data.data();
    if (codeData?.usedBy != null) {
      await ctx.reply(`Invite code has already been used. Please try again.`);
      return;
    }
    else{
    await updateDoc(codeDocRef, { usedBy: userId });
    const keyPair = await getOrCreateUserKeyPair(userId);
    await ctx.reply(`Looks like you are using the Game agent first time. You can fund your agent and start playing. Your unique Solana wallet is:`);
    await ctx.reply(`${String(keyPair.publicKey)}`);
    return;
    }
  }
  // Get or create user key pair
  const keyPair = await getOrCreateUserKeyPair(userId);
  if (keyPair.inProgress) {
    await ctx.reply(`Hold on! I'm still processing...`);
    return;
  }
  const {agent, config} = await initializeAgent(userId, keyPair);
  const stream = await agent.stream({ messages: [new HumanMessage(ctx.message.text)] }, config);
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 20000));
  try {
    await updateDoc(userDocRef, { inProgress: true });
    for await (const chunk of await Promise.race([stream, timeoutPromise]) as AsyncIterable<{ agent?: any; tools?: any }>) {
      if ("agent" in chunk) {
        if (chunk.agent.messages[0].content) await ctx.reply(String(chunk.agent.messages[0].content));
      } 
      // else if ("tools" in chunk) {
      //   if (chunk.tools.messages[0].content) await ctx.reply(String(chunk.tools.messages[0].content));
      // }
    }
  } catch (error: any) {
    if (error.message === 'Timeout') {
      await ctx.reply("I'm sorry, the operation took too long and timed out. Please try again.");
    } else {
      console.error("Error processing stream:", error);
      await ctx.reply("I'm sorry, an error occurred while processing your request.");
      await updateDoc(userDocRef, { inProgress: false });
    }
  }
  finally {
    await updateDoc(userDocRef, { inProgress: false });
  }
});


// Export webhook handler
export const POST = async (req: Request) => {
  // Mark the function as a background function for Vercel
  const headers = new Headers();
  headers.set('x-vercel-background', 'true');

  const handler = webhookCallback(bot, 'std/http'); // Use the correct callback

  // Handle the incoming webhook request
  return handler(req);
};