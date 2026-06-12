import globals from "globals"

export default [
  {
    ignores: [
      "node_modules/**",
      "config/**",
      "database/**",
      "mcp/**",
      "resources/**",
      "custom_tools/**",
      // 第三方逆向签名代码，不纳入 lint
      "functions/functions_tools/xiaohongshu/**"
    ]
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        // Yunzai 运行时注入的全局对象
        logger: "readonly",
        Bot: "readonly",
        redis: "readonly",
        segment: "readonly",
        plugin: "readonly"
      }
    },
    rules: {
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-dupe-class-members": "error",
      "no-const-assign": "error",
      "constructor-super": "error",
      "no-this-before-super": "error",
      "valid-typeof": "error",
      "no-debugger": "error",
      "no-unreachable": "warn",
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }]
    }
  },
  {
    // 这些文件包含 puppeteer page.evaluate() 回调，运行在浏览器上下文
    files: [
      "functions/functions_tools/puppeteer/**/*.js",
      "functions/functions_tools/webParserTool.js",
      "functions/tools/preview.js"
    ],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },
  {
    // y-tian-plugin 遗留的请求封装：代理相关分支被 getAgent() 首行 return false
    // 刻意短路（Config/HttpsProxyAgent 等未定义变量都在不可达路径里），
    // QQApi.js 依赖其 get/post，保持原样不动
    files: ["utils/request.js"],
    rules: {
      "no-undef": "off",
      "no-unreachable": "off"
    }
  }
]
