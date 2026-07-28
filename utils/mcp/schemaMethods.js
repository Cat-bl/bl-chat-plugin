// MCP 工具 schema 清洗 mixin：$ref 解引用、不支持字段剔除、顶层 object 归一。
// 从 MCPClient.js 拆出（行为等价搬迁），经 Object.assign 挂到 MCPClientManager.prototype，this 即 manager 实例。

const UNSUPPORTED_SCHEMA_FIELDS = [
  "$schema",
  "$id",
  "$comment",
  "examples",
  "default",
  "readOnly",
  "writeOnly",
  "deprecated",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "minContains",
  "maxContains"
]

const MODEL_SCHEMA_TYPES = new Set(["object", "string", "number", "integer", "boolean", "array"])
const SAFE_SCHEMA_FIELDS = new Set(["type", "description", "properties", "required", "items", "enum"])

export const schemaMethods = {
  resolveRef(ref, root) {
    if (!ref || typeof ref !== "string" || !ref.startsWith("#/")) return null

    const parts = ref.slice(2).split("/").map(part =>
      part.replace(/~1/g, "/").replace(/~0/g, "~")
    )
    let current = root
    for (const part of parts) {
      if (!current || typeof current !== "object" || !(part in current)) return null
      current = current[part]
    }
    return current
  },

  dereferenceSchema(schema, root = schema, seen = new Set()) {
    if (!schema || typeof schema !== "object") return schema
    if (Array.isArray(schema)) {
      return schema.map(item => this.dereferenceSchema(item, root, seen))
    }

    if (schema.$ref) {
      if (seen.has(schema.$ref)) {
        const { $ref: _ref, ...rest } = schema
        return this.dereferenceSchema(rest, root, seen)
      }

      const target = this.resolveRef(schema.$ref, root)
      if (target) {
        seen.add(schema.$ref)
        const { $ref: _ref, ...rest } = schema
        const merged = {
          ...this.dereferenceSchema(target, root, seen),
          ...this.dereferenceSchema(rest, root, seen)
        }
        seen.delete(schema.$ref)
        return merged
      }
    }

    const result = {}
    for (const [key, value] of Object.entries(schema)) {
      result[key] = this.dereferenceSchema(value, root, seen)
    }
    return result
  },

  cleanSchema(schema) {
    if (!schema || typeof schema !== "object") return schema

    const cleaned = JSON.parse(JSON.stringify(schema))
    const inferEnumType = values => {
      const filtered = (values || []).filter(value => value !== null && value !== undefined)
      if (!filtered.length) return null
      if (filtered.every(value => typeof value === "number" && Number.isFinite(value))) {
        return filtered.every(Number.isInteger) ? "integer" : "number"
      }
      if (filtered.every(value => typeof value === "boolean")) return "boolean"
      if (filtered.every(value => typeof value === "string")) return "string"
      return "string"
    }
    const normalizeType = (type, enumValues, obj = {}) => {
      const enumType = Array.isArray(enumValues) ? inferEnumType(enumValues) : null
      const declaredTypes = (Array.isArray(type) ? type : [type])
        .filter(value => value && value !== "null")
        .map(value => String(value))
        .filter(value => MODEL_SCHEMA_TYPES.has(value))

      if (enumType && (!declaredTypes.length || !declaredTypes.includes(enumType))) return enumType
      if (declaredTypes.length) return declaredTypes[0]
      if (enumType) return enumType
      if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) return "object"
      if (obj.items) return "array"
      return null
    }
    const coerceEnumValue = (value, type) => {
      if (value === null || value === undefined) return undefined
      if (type === "string") return String(value)
      if (type === "number") {
        const number = Number(value)
        return Number.isFinite(number) ? number : undefined
      }
      if (type === "integer") {
        const number = Number(value)
        return Number.isInteger(number) ? number : undefined
      }
      if (type === "boolean") {
        if (typeof value === "boolean") return value
        if (String(value).toLowerCase() === "true") return true
        if (String(value).toLowerCase() === "false") return false
        return undefined
      }
      return undefined
    }
    const mergeVariant = (target, source = {}) => {
      for (const [key, value] of Object.entries(source)) {
        if (["$ref", "$defs", "definitions", "const", "anyOf", "oneOf", "allOf"].includes(key)) continue
        if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
          target.properties = { ...(target.properties || {}), ...value }
        } else if (key === "required" && Array.isArray(value)) {
          target.required = [...new Set([...(target.required || []), ...value])]
        } else if (key === "enum" && Array.isArray(value)) {
          target.enum = [...(target.enum || []), ...value]
        } else if (target[key] === undefined) {
          target[key] = value
        }
      }
    }
    const collapseCombinators = obj => {
      if (Array.isArray(obj.allOf)) {
        for (const variant of obj.allOf) {
          if (variant && typeof variant === "object" && !Array.isArray(variant)) {
            mergeVariant(obj, variant)
          }
        }
      }

      for (const key of ["anyOf", "oneOf"]) {
        if (!Array.isArray(obj[key])) continue
        const variants = obj[key].filter(
          variant => variant && typeof variant === "object" && !Array.isArray(variant) && variant.type !== "null"
        )
        const enumValues = []
        for (const variant of variants) {
          if ("const" in variant) enumValues.push(variant.const)
          if (Array.isArray(variant.enum)) enumValues.push(...variant.enum)
        }
        if (enumValues.length) obj.enum = [...(obj.enum || []), ...enumValues]
        const base = variants.find(variant => variant.type && variant.type !== "null") || variants[0]
        if (base) mergeVariant(obj, base)
      }

      delete obj.allOf
      delete obj.anyOf
      delete obj.oneOf
    }
    const normalizeEnum = obj => {
      if (!Array.isArray(obj.enum)) return
      const type = normalizeType(obj.type, obj.enum, obj) || "string"
      obj.type = type

      if (!["string", "number", "integer", "boolean"].includes(type)) {
        delete obj.enum
        return
      }

      const seen = new Set()
      const normalized = []
      for (const value of obj.enum) {
        const coerced = coerceEnumValue(value, type)
        if (coerced === undefined) continue
        const key = `${typeof coerced}:${String(coerced)}`
        if (seen.has(key)) continue
        seen.add(key)
        normalized.push(coerced)
      }

      if (!normalized.length) {
        delete obj.enum
        return
      }

      if (type === "string" && normalized.every(value => typeof value === "string")) {
        obj.enum = normalized
        return
      }

      const enumText = normalized.map(value => String(value)).join("、")
      obj.description = obj.description
        ? `${obj.description}。可选值：${enumText}`
        : `可选值：${enumText}`
      delete obj.enum
    }
    const visitSchema = obj => {
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return

      if ("const" in obj && !Array.isArray(obj.enum)) {
        obj.enum = [obj.const]
      }
      collapseCombinators(obj)

      for (const field of UNSUPPORTED_SCHEMA_FIELDS) {
        delete obj[field]
      }
      delete obj.$ref
      delete obj.$defs
      delete obj.definitions
      delete obj.const

      obj.type = normalizeType(obj.type, obj.enum, obj) || obj.type
      if (!MODEL_SCHEMA_TYPES.has(obj.type)) delete obj.type
      normalizeEnum(obj)

      if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
        for (const [name, value] of Object.entries(obj.properties)) {
          if (value && typeof value === "object" && !Array.isArray(value)) {
            visitSchema(value)
          } else {
            obj.properties[name] = { type: "string" }
          }
        }
      } else {
        delete obj.properties
      }

      if (obj.items) {
        if (Array.isArray(obj.items)) obj.items = obj.items[0] || { type: "string" }
        if (obj.items && typeof obj.items === "object") visitSchema(obj.items)
        else delete obj.items
      }

      if (obj.type === "object") {
        if (!obj.properties) obj.properties = {}
        if (Array.isArray(obj.required)) {
          obj.required = obj.required
            .map(value => String(value))
            .filter(value => Object.prototype.hasOwnProperty.call(obj.properties, value))
        } else {
          obj.required = []
        }
      } else {
        delete obj.properties
        delete obj.required
      }

      if (obj.type === "array") {
        if (!obj.items) obj.items = { type: "string" }
      } else {
        delete obj.items
      }

      for (const key of Object.keys(obj)) {
        if (!SAFE_SCHEMA_FIELDS.has(key)) delete obj[key]
      }
    }

    visitSchema(cleaned)
    return cleaned
  },

  prepareInputSchema(schema) {
    try {
      if (!schema || typeof schema !== "object") {
        return { type: "object", properties: {}, required: [] }
      }

      const cloned = JSON.parse(JSON.stringify(schema))
      const dereferenced = this.dereferenceSchema(cloned, cloned)
      const cleaned = this.cleanSchema(dereferenced)

      if (!cleaned || typeof cleaned !== "object") {
        return { type: "object", properties: {}, required: [] }
      }

      if (!cleaned.type) cleaned.type = "object"
      if (cleaned.type === "object" && (!cleaned.properties || typeof cleaned.properties !== "object")) {
        cleaned.properties = {}
      }
      if (cleaned.type === "object" && !Array.isArray(cleaned.required)) {
        cleaned.required = []
      }

      return cleaned
    } catch (error) {
      logger.warn(`[MCP] 工具参数 schema 处理失败，已使用空参数兜底: ${error.message}`)
      return { type: "object", properties: {}, required: [] }
    }
  },
}
