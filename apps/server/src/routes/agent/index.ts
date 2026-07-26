/*
 * Licensed to Zero Email Inc. under one or more contributor license agreements.
 * You may not use this file except in compliance with the Apache License, Version 2.0 (the "License").
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Reuse or distribution of this file requires a license from Zero Email Inc.
 */

import { DurableObject } from 'cloudflare:workers';
import { type ZeroEnv } from '../../env';

/**
 * @deprecated Phase 3 of MIGRATION-PLAN.md: the per-(connection, shard)
 * ZeroDriver Durable Objects, the ShardRegistry, and the 8 GiB shard model
 * are replaced by the plain per-connection MailEngine (src/lib/mail-engine.ts)
 * with its thread/label index on Postgres. These empty shells exist only so
 * wrangler.jsonc's bindings and DO migrations still resolve on the workerd
 * path; they are deleted together with the rest of the DOs at cutover.
 *
 * Phase 5.4 removed the rest of this file: the ZeroAgent chat/WS Durable
 * Object (replaced by /api/chat HTTP streaming + the /realtime SSE relay)
 * and the Effect-era error/result types nothing imported anymore.
 */
export class ShardRegistry extends DurableObject<ZeroEnv> {}

/** @deprecated See ShardRegistry note above — replaced by MailEngine. */
export class ZeroDriver extends DurableObject<ZeroEnv> {}
