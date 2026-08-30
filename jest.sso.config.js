// Standalone config for the Konversify SSO suite. The root `test` script
// (getJestProjects) needs @nx/jest, which is not installed in this fork;
// this config runs the SSO specs directly with ts-jest.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/apps/backend/src/services/konversify-sso'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'es2015',
          module: 'commonjs',
          moduleResolution: 'node',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          strict: true,
          strictNullChecks: false,
          noImplicitAny: true,
          skipLibCheck: true,
          lib: ['es2020', 'dom'],
          importHelpers: false,
          types: ['node', 'jest'],
        },
      },
    ],
  },
  moduleNameMapper: {
    '^@gitroom/backend/(.*)$': '<rootDir>/apps/backend/src/$1',
    '^@gitroom/nestjs-libraries/(.*)$':
      '<rootDir>/libraries/nestjs-libraries/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
    '^@gitroom/react/(.*)$': '<rootDir>/libraries/react-shared-libraries/src/$1',
  },
  testTimeout: 20000,
};
