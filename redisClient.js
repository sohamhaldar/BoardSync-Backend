import Redis from "ioredis";

const connectToRedis=async()=>{
    try {
        const redis=new Redis(process.env.REDIS_URL); 
        // const redis=new Redis(); 
        return redis;   
    } catch (error) {
        throw new Error(error.message);
    }
}


export default connectToRedis;
