import { greet, type Visitor } from './greeter';

const visitor: Visitor = { name: 'world', visits: 1 };
export const message = greet(visitor.name);
