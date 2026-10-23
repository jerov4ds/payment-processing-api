/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 15000,
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.test.json",
      },
    ],
  },
  coverageDirectory: "coverage",
  coverageProvider: "v8",
  collectCoverageFrom: ["src/domain/**/*.ts", "src/services/**/*.ts"],
  coverageThreshold: {
    "./src/domain/": {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
    "./src/services/": {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
};
