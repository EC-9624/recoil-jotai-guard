import {myAtom} from './recoil-basic';

// Initializer function: set() calls here should be classified as 'initializer'
export function initializePressReleaseContents(set, data) {
  set(myAtom, data.title);
}

// Regular function: set() calls here should NOT be classified as initializer
export function updatePressReleaseContents(set, data) {
  set(myAtom, data.title);
}
