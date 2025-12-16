import sharp from 'sharp';
import fs from 'fs';
import { CHECK_IMG, DEERPIPE_IMG } from '../constants/core.js';

function getMonthCalendar(now) {
    const year = now.getFullYear();
    const month = now.getMonth(); // 当前月，0表示1月，11表示12月

    // 获取当前月的天数
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // 获取当前月的第一天是星期几，并调整为周一为一周的开始
    let firstDayOfMonth = new Date(year, month, 1).getDay();
    firstDayOfMonth = (firstDayOfMonth === 0) ? 6 : firstDayOfMonth - 1; // 调整为以周一为起始日

    // 创建一个二维数组，表示6行7列的日历（最多6周）
    const cal = [];
    let week = new Array(7).fill(null); // 初始化一周的天数为空

    // 填充空白日期到第一天
    let day = 1;
    for (let i = firstDayOfMonth; i < 7; i++) {
        week[i] = day++;
    }

    // 添加第一周到日历
    cal.push(week);

    // 填充剩余的日期
    while (day <= daysInMonth) {
        week = new Array(7).fill(null); // 初始化新的一周为空
        for (let i = 0; i < 7 && day <= daysInMonth; i++) {
            week[i] = day++;
        }
        cal.push(week);
    }

    return cal;
}


/**
 * 生成签到图片
 * 源代码来自：https://github.com/SamuNatsu/nonebot-plugin-deer-pipe/blob/main/src/nonebot_plugin_deer_pipe/image.py
 * @param now
 * @param name
 * @param deer
 * @returns {Promise<*>}
 */
export async function generateImage(now, name, deer) {
    const cal = getMonthCalendar(now);

    const IMG_W = 700;
    const BOX_W = 100;
    const BOX_H = 100;
    const IMG_H = BOX_H * (cal.length + 1);

    // 创建一个空白的图像作为背景
    let compositeArray = [{
        input: {
            create: {
                width: IMG_W,
                height: IMG_H,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            }
        }
    }];

    // 加载需要的图像资源
    const deerpipeBuffer = fs.readFileSync(DEERPIPE_IMG);
    const checkBuffer = fs.readFileSync(CHECK_IMG);

    // 遍历日历，构建 composite 数组
    for (let weekIdx = 0; weekIdx < cal.length; weekIdx++) {
        for (let dayIdx = 0; dayIdx < cal[weekIdx].length; dayIdx++) {
            const day = cal[weekIdx][dayIdx];
            const x0 = dayIdx * BOX_W;
            const y0 = (weekIdx + 1) * BOX_H;
            if (day !== null) {
                // 底图
                compositeArray.push({
                    input: deerpipeBuffer,
                    top: y0,
                    left: x0
                });

                // 日期数字
                compositeArray.push({
                    input: Buffer.from(
                        `<svg width="${BOX_W}" height="${BOX_H}">
                            <text x="5" y="${BOX_H - 35}" font-size="30" font-family="MiSans" fill="black">${day}</text>
                        </svg>`
                    ),
                    top: y0,
                    left: x0
                });

                // 签到标记
                if (deer[day]) {
                    compositeArray.push({
                        input: checkBuffer,
                        top: y0,
                        left: x0
                    });

                    // 签到次数
                    if (deer[day] > 1) {
                        const txt = deer[day] > 99 ? 'x99+' : `x${deer[day]}`;
                        compositeArray.push({
                            input: Buffer.from(
                                `<svg width="${BOX_W}" height="${BOX_H}">
                                    <text x="${BOX_W - 5}" y="${BOX_H - 20}" font-size="30" font-family="MiSans" fill="red" text-anchor="end" font-weight="bold">${txt}</text>
                                </svg>`
                            ),
                            top: y0,
                            left: x0
                        });
                    }
                }
            }
        }
    }

    // 添加标题和用户名
    compositeArray.push({
        input: Buffer.from(
            `<svg width="${IMG_W}" height="${BOX_H}">
                <text x="5" y="35" font-size="30" font-family="MiSans" fill="black">${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')} 签到</text>
                <text x="5" y="85" font-size="30" font-family="MiSans" fill="black">${name}</text>
            </svg>`
        ),
        top: 0,
        left: 0
    });

    const imgBuffer = await sharp({
        create: {
            width: IMG_W,
            height: IMG_H,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
    })
        .composite(compositeArray)
        .png()
        .toBuffer();

    return imgBuffer;
}


// 调用示例
// generateImage(new Date(), "测试", {
//     1: 2,
//     5: 1,
//     12: 99
// }).then(buffer => {
//     console.log("Image generated successfully");
//     // 可以写入文件或进行其他处理
// });
