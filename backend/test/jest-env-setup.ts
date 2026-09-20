import { config } from 'dotenv';
import { resolve } from 'path';

// Tests that touch PrismaService must never run against the dev database —
// point them at a dedicated test database before any test file (and the
// PrismaClient it constructs) is loaded.
config({ path: resolve(__dirname, '..', '.env.test'), override: true });
