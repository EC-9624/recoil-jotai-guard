// A file with non-hook function calls -- should produce no bindings
export function someUtilityFunction() {
  return 'hello';
}

export function Consumer() {
  const result = someUtilityFunction();
  return result;
}
