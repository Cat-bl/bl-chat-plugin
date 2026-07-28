// 用户历史记录持久化：redis 优先、本地 JSON 兜底双写。从 fileUtils.js 拆出（行为等价搬迁）。
import _ from "lodash";
import fs from "fs";
import path from "path";

/**
 * 保存用户历史记录
 * 优先保存到 Redis，然后同步保存到本地 JSON 文件
 * 即使 Redis 保存成功，也会同步保存到本地
 * 如果 Redis 保存失败，仍然会保存到本地文件
 * @param {string} userId - 用户 ID
 * @param {string} dirpath - 本地存储目录路径
 * @param {Array} history - 用户历史记录数组
 */
export async function saveUserHistory(userId, dirpath, history, type) {
  const redisKey = `YTUSER_${type}:${userId}`;
  const historyPath = path.join(dirpath, 'user_cache', `${userId}.json`);
  try {
    const lastSystemMessage = history.filter(item => item.role === 'system').pop();
    if (lastSystemMessage) {
      history = history.filter(item => item.role !== 'system');
      history.unshift(lastSystemMessage);
    }
    const historyJson = JSON.stringify(history, null, 2);
    try {
      await redis.set(redisKey, historyJson);
      console.log(`用户历史已保存到 Redis: ${userId}`);
    } catch (redisErr) {
      console.error(`保存用户历史到 Redis 失败: ${redisErr}`);
    }
    const dir = path.dirname(historyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(historyPath, historyJson, { encoding: 'utf-8' });
    console.log(`用户历史已保存到本地文件: ${historyPath}`);
  } catch (err) {
    console.error(`保存用户历史失败: ${err}`);
  }
}

/**
 * 从 Redis 加载数据，如果失败则从本地文件读取
 * @param {string} redisKey - Redis 的键
 * @param {string} filePath - 本地文件路径
 * @returns {Array} 加载的数据
 */
export async function loadData(redisKey, filePath) {
  try {
    const data = await redis.get(redisKey);
    if (data) {
      console.log(`从 Redis 加载数据成功: ${redisKey}`);
      return JSON.parse(data);
    } else {
      console.log(`Redis 中没有数据，尝试从本地文件加载: ${filePath}`);
      if (fs.existsSync(filePath)) {
        const fileData = await fs.promises.readFile(filePath, 'utf-8');
        const parsedData = JSON.parse(fileData);
        try {
          // 将本地数据缓存到 Redis
          await redis.set(redisKey, JSON.stringify(parsedData));
          console.log(`将本地数据缓存到 Redis 成功: ${redisKey}`);
        } catch (err) {
          console.error(`将本地数据缓存到 Redis 失败: ${err}`);
        }
        return parsedData;
      } else {
        console.log(`本地文件不存在: ${filePath}`);
        return [];
      }
    }
  } catch (err) {
    console.error(`从 Redis 加载数据失败: ${err}，尝试从本地文件加载`);
    try {
      if (fs.existsSync(filePath)) {
        const fileData = await fs.promises.readFile(filePath, 'utf-8');
        return JSON.parse(fileData);
      } else {
        console.log(`本地文件不存在: ${filePath}`);
        return [];
      }
    } catch (fileErr) {
      console.error(`从本地文件加载数据失败: ${fileErr}`);
      return [];
    }
  }
}

/**
 * 加载用户历史记录
 * 优先从 Redis 获取，如果失败则从本地 JSON 文件读取
 * @param {string} userId - 用户 ID
 * @param {string} dirpath - 本地存储目录路径
 * @returns {Array} 用户历史记录数组
 */
export async function loadUserHistory(userId, dirpath, type) {
  const redisKey = `YTUSER_${type}:${userId}`;
  const historyPath = path.join(dirpath, 'user_cache', `${userId}.json`);
  try {
    const data = await redis.get(redisKey);
    if (data) {
      console.log(`从 Redis 加载用户历史成功: ${userId}`);
      return JSON.parse(data);
    } else {
      console.log(`Redis 中没有数据，尝试从本地文件加载: ${historyPath}`);
      if (fs.existsSync(historyPath)) {
        const fileData = fs.readFileSync(historyPath, 'utf-8');
        const parsedData = JSON.parse(fileData);
        try {
          await redis.set(redisKey, JSON.stringify(parsedData));
          console.log(`将本地数据缓存到 Redis 成功: ${userId}`);
        } catch (err) {
          console.error(`将本地数据缓存到 Redis 失败: ${err}`);
        }
        return parsedData;
      } else {
        console.log(`本地文件不存在: ${historyPath}`);
        return [];
      }
    }
  } catch (err) {
    console.error(`从 Redis 加载用户历史失败: ${err}，尝试从本地文件加载`);
    try {
      if (fs.existsSync(historyPath)) {
        const fileData = fs.readFileSync(historyPath, 'utf-8');
        return JSON.parse(fileData);
      } else {
        console.log(`本地文件不存在: ${historyPath}`);
        return [];
      }
    } catch (fileErr) {
      console.error(`从本地文件加载用户历史失败: ${fileErr}`);
      return [];
    }
  }
}

/**
 * 保存数据到 Redis，并同步保存到本地文件
 * @param {string} redisKey - Redis 的键
 * @param {string} filePath - 本地文件路径
 * @param {Array} data - 要保存的数据
 * @returns {Object} 保存结果
 */
export async function saveData(redisKey, filePath, data) {
  const dataJson = JSON.stringify(data, null, 2);
  try {
    // 尝试保存到 Redis
    await redis.set(redisKey, dataJson);
    console.log(`数据已保存到 Redis: ${redisKey}`);
  } catch (redisErr) {
    console.error(`保存数据到 Redis 失败: ${redisErr}`);
  }

  try {
    // 同步保存到本地文件
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.writeFile(filePath, dataJson, 'utf-8');
    console.log(`数据已保存到本地文件: ${filePath}`);
  } catch (fileErr) {
    console.error(`保存数据到本地文件失败: ${fileErr}`);
  }

  return { success: true };
}
