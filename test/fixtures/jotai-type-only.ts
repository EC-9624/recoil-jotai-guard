import {type SetStateAction, type createStore} from 'jotai';

// These should NOT be recorded as JotaiImports
const x: SetStateAction<string> = '';
