const _path = process.cwd();
import fetch from "node-fetch";
import path from "path";
import crypto from 'crypto';
import http from "http";
import https from "https";
import YAML from "yaml";
import os from "os";
import querystring from 'querystring';
import fs from "fs";
import moment from "moment";
import cfg from "../../../lib/config/config.js";
import puppeteer from "../../../lib/puppeteer/puppeteer.js";
import common from "../../../lib/common/common.js";
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import FormData from 'form-data';
import request from "request";
import WebSocket from 'ws';
import axios from "axios";
import { getEncoding } from 'js-tiktoken';
import textract from 'textract';
import mimeTypes from "mime-types";
import { isPluginCommand } from "../functions/ask-ban.js";
import { processArray, countTextInString } from '../functions/tools/messageGenerator.js';
import { extractAndRender, extractCodeBlocks } from '../functions/tools/preview.js';
import { bilibiliParser } from "../functions/tools/bilibilivideoanalysis.js";

export const dependencies = {
  fs,
  os,
  cfg,
  http,
  path,
  fetch,
  https,
  axios,
  _path,
  YAML,
  crypto,
  require,
  request,
  moment,
  common,
  getEncoding,
  FormData,
  puppeteer,
  WebSocket,
  mimeTypes,
  querystring,
  textract,
  processArray,
  countTextInString,
  isPluginCommand,
  extractAndRender,
  extractCodeBlocks,
  bilibiliParser
}