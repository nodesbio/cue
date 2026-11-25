/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js'],
  // Mirror tsconfig paths ("@/*" -> "./*") so value imports across dirs resolve
  // in tests. Type-only "@/..." imports were stripped by ts-jest and never hit
  // the resolver, which hid the gap until the first cross-dir value import.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: './tsconfig.test.json' }],
  },
};
