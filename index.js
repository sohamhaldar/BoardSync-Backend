import express from 'express';
import cors from 'cors';
import {Server} from 'socket.io';
import dotenv from 'dotenv';
import http from 'http';
import connectToRedis from './redisClient.js';

dotenv.config({
    path:'./.env'
})
const app=express();
const server=http.createServer(app);
let redis;
try{
    redis=await connectToRedis();
    console.log('Redis connected succesfully');
} catch (error) {
    console.log(error);
}

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static('public'));

app.use(cors({
    origin:process.env.CORS_ORIGIN,
    credentials:true
}))

const io=new Server(server,{
    cors:{
        origin:process.env.CORS_ORIGIN,
        credentials:true
    }
})

app.get('/ping', (req, res) => {
    res.status(200).json({ message: 'Server is up and running' });
  });

io.on('connection',(socket)=>{
    console.log('Socket connected with id',socket.id);
    socket.on('join-workspace',async(result)=>{
        console.log(result);
        socket.join(result.workspaceId);
        console.log("User"+ socket.id+"Joined Room: " + result.workspaceId); 
        io.to(result.workspaceId).emit('user-joined',`someone joined ${socket.id}`);
    })
    socket.on('get-chats', async (result) => {
        let pastChats = await redis.lrange(`chats:${result.workspaceId}`, 0, -1);
        let chats = [];
    
        if (pastChats.length === 0) {
            console.log('No chats found in Redis, fetching from database');
            try {
                const response = await fetch(`${process.env.CLIENT_URL}/api/workspaces/getworkspace?workspaceId=${result.workspaceId}`);
                const data = await response.json();
                if (response.ok && data?.data?.chats) {
                    chats = data.data.chats;
                    for (const chat of chats) {
                        await redis.rpush(`chats:${result.workspaceId}`, JSON.stringify(chat));
                    }
                    pastChats = await redis.lrange(`chats:${result.workspaceId}`, 0, -1);
                    const newchats = pastChats.map(chat => {
                        try {
                            return JSON.parse(chat);
                        } catch (error) {
                            console.error("Error parsing chat message:", error);
                            return null;
                        }
                    }).filter(chat => chat !== null);
                    await redis.set(`lastPersistedChatIndex:${result.workspaceId}`, newchats.length - 1);
                    // await redis.set(`lastPersistedChatIndex:${roomId}`, chats.length - 1);
                }
            } catch (error) {
                console.error('Error fetching chats from database:', error);
            }
        } else {
            chats = pastChats.map(chat => {
                try {
                    return JSON.parse(chat);
                } catch (error) {
                    console.error("Error parsing chat message:", error);
                    return null;
                }
            }).filter(chat => chat !== null);
        }
    
        console.log(chats);
        io.to(socket.id).emit('get-chats', {
            chats
        });
    });

    socket.on('board-changes',async(result)=>{
        await redis.set(`board:${result.workspaceId}`,JSON.stringify(result));
        socket.to(result.workspaceId).emit('board-changes',result);
    })

    socket.on('get-board',async(result)=>{
        let pastData=await redis.get(`board:${result.workspaceId}`);
        if(!pastData){
            console.log('No redis found');
            console.log(result.workspaceId);
            const response=await fetch(`${process.env.CLIENT_URL}/api/workspaces/getworkspace?workspaceId=${result.workspaceId}`);
            const data=await response.json();
            console.log('data:',data);
            if(response.ok){
                pastData=data?.data?.board;
            }
            
        }
        if(pastData){
            io.to(socket.id).emit('get-board',{
            board:JSON.parse(pastData)
        })
        }
        
    })

    socket.on('message', async (result) => {
        console.log(result);
        await redis.rpush(`chats:${result.workspaceId}`, JSON.stringify(result));
        // const currentIndex=await redis.get(`lastPersistedChatIndex:${result.workspaceId}`);
        // const nextIndex=parseInt(currentIndex)+1;
        // await redis.set(`lastPersistedChatIndex:${result.workspaceId}`, nextIndex);
        io.to(result.workspaceId).emit('message', result);
    });

    socket.on('disconnect',()=>{
        console.log('User disconnected: ',socket.id);
    })
    
})

const SAVE_INTERVAL = 60000;


async function saveBoardToDB() {
    
    const rooms = await redis.keys('board:*');
    console.log('starting persisting board');
    for (const roomKey of rooms) {
      const roomId = roomKey.split(':')[1];
      console.log('persisting board of id:',roomId);
      let boardData=await redis.get(roomKey);
      try {
            const response=await fetch(`${process.env.CLIENT_URL}/api/workspaces/persist-board`,{
                method:'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body:JSON.stringify({
                    workspaceId:roomId,
                    boardData

                })
            });
            if(response.ok){
                console.log('succesfully persisted board of id:',roomId);
            }else{
                console.log('error occured when persisting board of id:',roomId);
                console.log(response);
            }
      } catch (error) {
        console.error('Error saving drawing to MongoDB:', error);
      }
    }
}
async function saveChatsToDB() {
    const rooms = await redis.keys('chats:*');
    console.log('starting persisting chats');
    for (const roomKey of rooms) {
        const roomId = roomKey.split(':')[1];
        console.log('checking chats of id:', roomId);
        
        let pastChats = await redis.lrange(roomKey, 0, -1);
        const chats = pastChats.map(chat => {
            try {
                return JSON.parse(chat);
            } catch (error) {
                console.error("Error parsing chat message:", error);
                return null;
            }
        }).filter(chat => chat !== null);
        
        const lastPersistedIndex = await redis.get(`lastPersistedChatIndex:${roomId}`) || -1;
        
        const newChats = chats.slice(parseInt(lastPersistedIndex) + 1);
        
        if (newChats.length > 0) {
            console.log('persisting chats of id:', roomId);
            try {
                const response = await fetch(`${process.env.CLIENT_URL}/api/workspaces/persist-chats`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        workspaceId: roomId,
                        chats: newChats
                    })
                });
                if (response.ok) {
                    console.log('successfully persisted chats of id:', roomId);
                    await redis.set(`lastPersistedChatIndex:${roomId}`, chats.length - 1);
                } else {
                    console.log('error occurred when persisting chats of id:', roomId);
                    console.log(response);
                }
            } catch (error) {
                console.error('Error saving chats to MongoDB:', error);
            }
        } else {
            console.log('No new chats to persist for id:', roomId);
        }
    }
}
setInterval(saveBoardToDB, SAVE_INTERVAL);
setInterval(saveChatsToDB, SAVE_INTERVAL);


if(redis){
    server.listen(process.env.PORT||8000,()=>{
        console.log(`server connected at PORT:${process.env.PORT}`);
    });
}else{
    console.log('some error occured');
}

